import asyncio
import re
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.core.config import get_settings
from app.db.session import get_session
from app.main import create_app
from app.modules.auth import passwords
from app.modules.auth.models import PasswordResetToken
from app.modules.auth.passwords import InvalidResetToken
from app.modules.notifications.deps import get_sender
from app.modules.users.models import User
from tests.auth.conftest import cookie_token, refresh_with
from tests.conftest import create_user
from tests.notifications.test_notifier import FakeSender

REQUEST = "/api/v1/auth/password-reset/request"
CONFIRM = "/api/v1/auth/password-reset/confirm"
ACK = "如果這個 Email 有註冊，重設信已寄出，請在 30 分鐘內點信裡的連結"
INVALID = "重設連結已失效或已使用，請重新申請"
LOGIN = "/api/v1/auth/login"
OLD = "correct-horse"
NEW = "new-password-1"
BASE_URL = "http://localhost:5173"
T0 = datetime(2026, 11, 22, 12, 0, tzinfo=UTC)


@pytest.fixture
def sender(app: FastAPI) -> FakeSender:
    fake = FakeSender()
    app.dependency_overrides[get_sender] = lambda: fake
    return fake


def _token_from(sender: FakeSender, index: int = -1) -> str:
    match = re.search(r"/reset-password\?token=([\w-]+)", sender.attempts[index].text)
    assert match is not None
    return match.group(1)


async def _count_tokens(session: AsyncSession) -> int:
    return await session.scalar(select(func.count()).select_from(PasswordResetToken)) or 0


async def test_request_same_response_for_all(
    client: AsyncClient, db_session: AsyncSession, sender: FakeSender
) -> None:
    await create_user(db_session)
    await create_user(db_session, email="off@example.com", is_active=False)
    await create_user(db_session, email="demo@example.com", is_demo=True)

    for email in ("alice@example.com", "off@example.com", "demo@example.com", "none@example.com"):
        resp = await client.post(REQUEST, json={"email": email})
        assert resp.status_code == 202
        assert resp.json() == {"detail": ACK}

    assert len(sender.attempts) == 1
    mail = sender.attempts[0]
    assert mail.to == "alice@example.com"
    assert mail.subject == "FareWatch 重設密碼"
    assert f"{get_settings().app_base_url.rstrip('/')}/reset-password?token=" in mail.text


async def test_request_normalizes_email(
    client: AsyncClient, db_session: AsyncSession, sender: FakeSender
) -> None:
    await create_user(db_session)
    resp = await client.post(REQUEST, json={"email": " Alice@Example.com "})
    assert resp.status_code == 202
    assert [m.to for m in sender.attempts] == ["alice@example.com"]


async def test_request_cooldown(
    client: AsyncClient, db_session: AsyncSession, sender: FakeSender
) -> None:
    await create_user(db_session)
    for _ in range(2):
        resp = await client.post(REQUEST, json={"email": "alice@example.com"})
        assert resp.status_code == 202
        assert resp.json() == {"detail": ACK}
    assert len(sender.attempts) == 1


async def test_send_failure_still_202(
    client: AsyncClient, db_session: AsyncSession, app: FastAPI
) -> None:
    await create_user(db_session)
    app.dependency_overrides[get_sender] = lambda: FakeSender(error="boom")
    resp = await client.post(REQUEST, json={"email": "alice@example.com"})
    assert resp.status_code == 202
    assert resp.json() == {"detail": ACK}
    assert await _count_tokens(db_session) == 1


async def test_confirm_resets_password(
    client: AsyncClient, db_session: AsyncSession, sender: FakeSender
) -> None:
    await create_user(db_session)
    login = await client.post(LOGIN, json={"email": "alice@example.com", "password": OLD})
    old_refresh = cookie_token(login)

    await client.post(REQUEST, json={"email": "alice@example.com"})
    resp = await client.post(CONFIRM, json={"token": _token_from(sender), "new_password": NEW})
    assert resp.status_code == 204

    bad = await client.post(LOGIN, json={"email": "alice@example.com", "password": OLD})
    assert bad.status_code == 401
    good = await client.post(LOGIN, json={"email": "alice@example.com", "password": NEW})
    assert good.status_code == 200
    assert (await refresh_with(client, old_refresh)).status_code == 401


async def test_confirm_unlocks_account(
    client: AsyncClient, db_session: AsyncSession, sender: FakeSender
) -> None:
    user = await create_user(db_session)
    user.locked_until = datetime.now(UTC) + timedelta(minutes=10)
    user.failed_login_count = 3
    await db_session.flush()

    await client.post(REQUEST, json={"email": "alice@example.com"})
    resp = await client.post(CONFIRM, json={"token": _token_from(sender), "new_password": NEW})
    assert resp.status_code == 204
    good = await client.post(LOGIN, json={"email": "alice@example.com", "password": NEW})
    assert good.status_code == 200


async def test_confirm_twice_fails(
    client: AsyncClient, db_session: AsyncSession, sender: FakeSender
) -> None:
    await create_user(db_session)
    await client.post(REQUEST, json={"email": "alice@example.com"})
    body = {"token": _token_from(sender), "new_password": NEW}
    assert (await client.post(CONFIRM, json=body)).status_code == 204
    resp = await client.post(CONFIRM, json=body)
    assert resp.status_code == 400
    assert resp.json()["detail"] == INVALID


@pytest.mark.parametrize("token", ["", "abc"])
async def test_confirm_garbage_token(client: AsyncClient, token: str) -> None:
    resp = await client.post(CONFIRM, json={"token": token, "new_password": NEW})
    assert resp.status_code == 400
    assert resp.json()["detail"] == INVALID


async def test_confirm_same_as_old_password_allowed(
    client: AsyncClient, db_session: AsyncSession, sender: FakeSender
) -> None:
    await create_user(db_session)
    await client.post(REQUEST, json={"email": "alice@example.com"})
    resp = await client.post(CONFIRM, json={"token": _token_from(sender), "new_password": OLD})
    assert resp.status_code == 204


async def test_confirm_short_password_422(
    client: AsyncClient, db_session: AsyncSession, sender: FakeSender
) -> None:
    await create_user(db_session)
    await client.post(REQUEST, json={"email": "alice@example.com"})
    resp = await client.post(
        CONFIRM, json={"token": _token_from(sender), "new_password": "1234567"}
    )
    assert resp.status_code == 422


async def _request(session: AsyncSession, sender: FakeSender, now: datetime) -> None:
    await passwords.request_reset(session, sender, BASE_URL, "alice@example.com", now)


async def test_new_request_voids_old_token(db_session: AsyncSession) -> None:
    await create_user(db_session)
    sender = FakeSender()
    await _request(db_session, sender, T0)
    await _request(db_session, sender, T0 + timedelta(minutes=6))
    token_a, token_b = _token_from(sender, 0), _token_from(sender, 1)

    with pytest.raises(InvalidResetToken):
        await passwords.confirm_reset(db_session, token_a, NEW, T0 + timedelta(minutes=7))
    await passwords.confirm_reset(db_session, token_b, NEW, T0 + timedelta(minutes=7))


async def test_token_expires_after_30_minutes(db_session: AsyncSession) -> None:
    await create_user(db_session)
    sender = FakeSender()
    await _request(db_session, sender, T0)
    token = _token_from(sender)

    with pytest.raises(InvalidResetToken):
        await passwords.confirm_reset(db_session, token, NEW, T0 + timedelta(minutes=30, seconds=1))
    await passwords.confirm_reset(db_session, token, NEW, T0 + timedelta(minutes=29))


async def test_cooldown_lifts_after_5_minutes(db_session: AsyncSession) -> None:
    await create_user(db_session)
    sender = FakeSender()
    await _request(db_session, sender, T0)
    await _request(db_session, sender, T0 + timedelta(minutes=4))
    assert len(sender.attempts) == 1
    await _request(db_session, sender, T0 + timedelta(minutes=5, seconds=1))
    assert len(sender.attempts) == 2


async def test_confirm_for_deactivated_user_fails(db_session: AsyncSession) -> None:
    user = await create_user(db_session)
    sender = FakeSender()
    await _request(db_session, sender, T0)
    user.is_active = False
    await db_session.flush()

    with pytest.raises(InvalidResetToken):
        await passwords.confirm_reset(db_session, _token_from(sender), NEW, T0)


async def test_set_password_voids_tokens_and_unlocks(db_session: AsyncSession) -> None:
    user = await create_user(db_session)
    user.failed_login_count = 2
    await db_session.flush()
    sender = FakeSender()
    await _request(db_session, sender, T0)

    await passwords.set_password(db_session, user, NEW, T0)

    assert user.failed_login_count == 0
    assert user.locked_until is None
    used = await db_session.scalar(select(PasswordResetToken.used_at))
    assert used == T0


async def test_concurrent_confirm_only_one_succeeds(engine: AsyncEngine) -> None:
    # 真的並行：兩個請求各用自己的連線，資料要先 commit，結束後手動清掉
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as seed:
        user = await create_user(seed, email="concurrent-reset@example.com")
        user_id = user.id
        fake = FakeSender()
        await passwords.request_reset(
            seed, fake, BASE_URL, "concurrent-reset@example.com", datetime.now(UTC)
        )
        token = _token_from(fake)

    app = create_app()

    async def _own_session():  # type: ignore[no-untyped-def]
        async with maker() as s:
            yield s

    app.dependency_overrides[get_session] = _own_session
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="https://test") as c:
            body = {"token": token, "new_password": NEW}
            resps = await asyncio.gather(c.post(CONFIRM, json=body), c.post(CONFIRM, json=body))
        assert sorted(r.status_code for r in resps) == [204, 400]
    finally:
        async with maker() as cleanup:
            await cleanup.execute(delete(User).where(User.id == user_id))
            await cleanup.commit()
