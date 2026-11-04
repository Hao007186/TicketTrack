"""立即查價：建立或修改追蹤後、表單填目標價前，不等排程先查一次。"""

import asyncio
import logging
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from typing import Literal

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.alerts.service import alert_on_recent_price
from app.modules.notifications.email import EmailSender
from app.modules.notifications.notifier import send_after_request
from app.modules.notifications.service import notify_quota_exhausted
from app.modules.prices.budget import daily_budget
from app.modules.prices.checker import (
    claim_query,
    record_result,
    restore_query,
    today_start,
    usage_month,
)
from app.modules.prices.models import InstantCheckUsage
from app.modules.prices.providers.base import PriceProvider, ProviderError
from app.modules.prices.schemas import InstantResult
from app.modules.watches.models import PriceQuery, Watch
from app.modules.watches.service import conditions_of
from app.modules.watches.slots import STOP_CHECK_DAYS, occupied_query_ids

logger = logging.getLogger(__name__)

MAX_INSTANT_CHECKS_PER_DAY = 3
# pg_advisory_xact_lock 的鍵，和 slots.WATCH_LOCK_KEY 分開："FARF" 的 ASCII
INSTANT_LOCK_KEY = 0x46415246
# 查額度與查價合計；API Lambda 上限 30 秒，要留時間給記錄結果與寄信
INSTANT_TIMEOUT_SECONDS: float = 15


def _utcnow() -> datetime:
    return datetime.now(UTC)


async def reserve_slot(
    session: AsyncSession, user_id: int, today: date, budget: int | None
) -> Literal["ok", "user_limit", "site_limit"]:
    """呼叫查價來源前先扣次數；鎖讓同時發多個請求也不會超過上限。budget 是 None 時不檢查全站。"""
    await session.execute(select(func.pg_advisory_xact_lock(INSTANT_LOCK_KEY)))
    used = await session.scalar(
        select(InstantCheckUsage.count).where(
            InstantCheckUsage.user_id == user_id, InstantCheckUsage.day == today
        )
    )
    if (used or 0) >= MAX_INSTANT_CHECKS_PER_DAY:
        await session.commit()
        return "user_limit"
    if budget is not None:
        site_used = await session.scalar(
            select(func.coalesce(func.sum(InstantCheckUsage.count), 0)).where(
                InstantCheckUsage.day == today
            )
        )
        if (site_used or 0) >= budget:
            await session.commit()
            return "site_limit"
    stmt = insert(InstantCheckUsage).values(user_id=user_id, day=today, count=1)
    await session.execute(
        stmt.on_conflict_do_update(
            index_elements=[InstantCheckUsage.user_id, InstantCheckUsage.day],
            set_={"count": InstantCheckUsage.count + 1},
        )
    )
    await session.commit()
    return "ok"


async def refund_slot(session: AsyncSession, user_id: int, today: date) -> None:
    await session.execute(
        update(InstantCheckUsage)
        .where(
            InstantCheckUsage.user_id == user_id,
            InstantCheckUsage.day == today,
            InstantCheckUsage.count > 0,
        )
        .values(count=InstantCheckUsage.count - 1)
    )
    await session.commit()


async def check_query(
    session: AsyncSession,
    provider: PriceProvider,
    sender: EmailSender,
    base_url: str,
    user_id: int,
    query: PriceQuery,
    today: date,
    now: Callable[[], datetime] = _utcnow,
) -> InstantResult:
    # 寄信失敗 rollback 後 query 會過期，先存起來
    query_id = query.id
    last_checked_at = await session.scalar(
        select(PriceQuery.last_checked_at)
        .where(PriceQuery.id == query_id)
        .execution_options(populate_existing=True)
    )
    if last_checked_at is not None and last_checked_at >= today_start(today):
        return "already_checked"

    deadline = asyncio.get_running_loop().time() + INSTANT_TIMEOUT_SECONDS
    try:
        async with asyncio.timeout_at(deadline):
            remaining = await provider.remaining_quota()
    except (ProviderError, TimeoutError) as e:
        logger.warning("立即查價拿不到剩餘額度（query %s）：%s", query_id, e)
        return "failed"
    if remaining == 0:
        logger.warning("本月額度已用完")
        await notify_quota_exhausted(session, [query_id], usage_month(now()))
        await session.commit()
        return "quota_exhausted"

    # 每個啟用中的 query 每天留一次給排程，立即查價只能用剩下的，兩者合計才不會超過每日預算
    budget = (
        None
        if remaining is None
        else max(0, daily_budget(remaining, today) - len(await occupied_query_ids(session, today)))
    )
    reserved = await reserve_slot(session, user_id, today, budget)
    if reserved != "ok":
        return reserved

    claimed, previous = await claim_query(session, query_id, today, now())
    if not claimed:
        await refund_slot(session, user_id, today)
        return "already_checked"

    try:
        async with asyncio.timeout_at(deadline):
            result = await provider.search(conditions_of(query))
    except (ProviderError, TimeoutError) as e:
        logger.warning("立即查價失敗（query %s）：%s", query_id, e)
        await restore_query(session, query_id, previous)
        await refund_slot(session, user_id, today)
        return "failed"

    await record_result(session, query, provider.name, result, now())
    outcome: InstantResult = "no_result" if result.lowest is None else "checked"
    await send_after_request(session, sender, base_url, now)
    return outcome


async def check_watch(
    session: AsyncSession,
    provider: PriceProvider,
    sender: EmailSender,
    base_url: str,
    watch: Watch,
    today: date,
    now: Callable[[], datetime] = _utcnow,
) -> InstantResult:
    query = watch.price_query
    if watch.status != "active" or query.depart_date <= today + timedelta(days=STOP_CHECK_DAYS):
        return "not_eligible"
    result = await check_query(
        session, provider, sender, base_url, watch.user_id, query, today, now
    )
    # 這組條件今天查過（例如表單查過才建立追蹤）：查價時這個追蹤還不存在或條件不同，沒被判斷到
    if result == "already_checked" and await alert_on_recent_price(session, watch, now()):
        await session.commit()
        await send_after_request(session, sender, base_url, now)
    return result
