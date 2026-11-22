"""忘記密碼與改密碼共用的規則：重設連結的申請、完成，以及設定新密碼。"""

import logging
from datetime import datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.auth import security
from app.modules.auth.models import PasswordResetToken, RefreshToken
from app.modules.auth.service import get_user_by_email, normalize_email
from app.modules.notifications.email import EmailError, EmailMessage, EmailSender
from app.modules.users.models import User

logger = logging.getLogger(__name__)

RESET_TOKEN_TTL = timedelta(minutes=30)
RESET_COOLDOWN = timedelta(minutes=5)


class InvalidResetToken(Exception):
    pass


def build_reset_email(to: str, token: str, base_url: str) -> EmailMessage:
    link = f"{base_url.rstrip('/')}/reset-password?token={token}"
    minutes = int(RESET_TOKEN_TTL.total_seconds() // 60)
    text = (
        "你好，\n\n"
        "我們收到重設 FareWatch 密碼的申請。請點下面的連結設定新密碼：\n\n"
        f"{link}\n\n"
        f"這個連結 {minutes} 分鐘內有效，而且只能使用一次。\n"
        "重設後，你在所有裝置上的登入都會被登出，需要用新密碼重新登入。\n\n"
        "如果不是你本人申請的，直接忽略這封信即可，你的密碼不會改變。\n"
    )
    return EmailMessage(to=to, subject="FareWatch 重設密碼", text=text)


async def set_password(session: AsyncSession, user: User, new_password: str, now: datetime) -> None:
    """設定新密碼並解除鎖定，作廢所有未使用的重設連結與所有登入。不 commit，由呼叫端提交。"""
    user.password_hash = security.hash_password(new_password)
    user.failed_login_count = 0
    user.locked_until = None
    await session.execute(
        update(PasswordResetToken)
        .where(PasswordResetToken.user_id == user.id, PasswordResetToken.used_at.is_(None))
        .values(used_at=now)
    )
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=now)
    )


async def request_reset(
    session: AsyncSession, sender: EmailSender, base_url: str, email: str, now: datetime
) -> None:
    """帳號不存在、停用、示範帳號或冷卻中都靜默結束，呼叫端回應不能洩漏差異。"""
    user = await get_user_by_email(session, normalize_email(email))
    if user is None or not user.is_active or user.is_demo:
        return

    recent = await session.scalar(
        select(PasswordResetToken.id)
        .where(
            PasswordResetToken.user_id == user.id,
            PasswordResetToken.created_at > now - RESET_COOLDOWN,
        )
        .limit(1)
    )
    if recent is not None:
        return

    await session.execute(
        update(PasswordResetToken)
        .where(PasswordResetToken.user_id == user.id, PasswordResetToken.used_at.is_(None))
        .values(used_at=now)
    )
    token = security.new_refresh_token()
    session.add(
        PasswordResetToken(
            user_id=user.id,
            token_hash=security.hash_refresh_token(token),
            expires_at=now + RESET_TOKEN_TTL,
            created_at=now,
        )
    )
    user_id, to = user.id, user.email
    await session.commit()

    try:
        await sender.send(build_reset_email(to, token, base_url))
    except EmailError as e:
        # 不記 token；寄信失敗也照常回應，使用者可過冷卻時間後重新申請
        logger.warning("重設密碼信寄送失敗：user_id=%s，錯誤：%s", user_id, e)


async def confirm_reset(
    session: AsyncSession, token: str, new_password: str, now: datetime
) -> None:
    # 條件式標記已使用：兩個請求同時用同一個連結時，只有一個搶得到
    user_id = await session.scalar(
        update(PasswordResetToken)
        .where(
            PasswordResetToken.token_hash == security.hash_refresh_token(token),
            PasswordResetToken.used_at.is_(None),
            PasswordResetToken.expires_at > now,
        )
        .values(used_at=now)
        .returning(PasswordResetToken.user_id)
    )
    if user_id is None:
        raise InvalidResetToken

    user = await session.get(User, user_id, populate_existing=True)
    if user is None or not user.is_active or user.is_demo:
        await session.rollback()
        raise InvalidResetToken

    await set_password(session, user, new_password, now)
    await session.commit()
