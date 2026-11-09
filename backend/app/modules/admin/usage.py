"""後台用量：SerpApi 額度、今天的查價與立即查價、名額、本月寄信。"""

import asyncio
import logging
from datetime import date, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import TAIPEI_TZ
from app.modules.admin.schemas import AdminUsageOut
from app.modules.alerts.models import AlertDelivery
from app.modules.prices.budget import daily_budget
from app.modules.prices.checker import today_start
from app.modules.prices.instant import INSTANT_TIMEOUT_SECONDS
from app.modules.prices.models import ApiUsage, InstantCheckUsage
from app.modules.prices.providers.base import PriceProvider, ProviderError
from app.modules.watches.models import PriceQuery, Watch
from app.modules.watches.slots import MAX_ACTIVE_QUERIES, occupied_query_ids

logger = logging.getLogger(__name__)


async def _remaining(provider: PriceProvider) -> int | None:
    """account.json 不扣額度；拿不到就回 None，其他數字照常顯示。"""
    try:
        async with asyncio.timeout(INSTANT_TIMEOUT_SECONDS):
            return await provider.remaining_quota()
    except (ProviderError, TimeoutError) as e:
        logger.warning("後台拿不到 SerpApi 剩餘額度：%s", e)
        return None


async def get_usage(session: AsyncSession, provider: PriceProvider, today: date) -> AdminUsageOut:
    remaining = await _remaining(provider)
    budget = daily_budget(remaining, today) if remaining is not None else None
    month_start = datetime(today.year, today.month, 1, tzinfo=TAIPEI_TZ)

    month_calls = await session.scalar(
        select(ApiUsage.count).where(
            ApiUsage.provider == provider.name, ApiUsage.month == f"{today:%Y-%m}"
        )
    )
    checked_today = await session.scalar(
        select(func.count())
        .select_from(PriceQuery)
        .where(PriceQuery.is_demo.is_(False), PriceQuery.last_checked_at >= today_start(today))
    )
    instant_today = await session.scalar(
        select(func.coalesce(func.sum(InstantCheckUsage.count), 0)).where(
            InstantCheckUsage.day == today
        )
    )
    slots_used = len(await occupied_query_ids(session, today))
    queued = await session.scalar(
        select(func.count())
        .select_from(Watch)
        .join(PriceQuery, Watch.price_query_id == PriceQuery.id)
        .where(Watch.status == "queued", PriceQuery.is_demo.is_(False))
    )
    email_rows = await session.execute(
        select(AlertDelivery.status, func.count())
        .where(AlertDelivery.channel == "email", AlertDelivery.created_at >= month_start)
        .group_by(AlertDelivery.status)
    )
    emails: dict[str, int] = {status: count for status, count in email_rows}

    instant_used = instant_today or 0
    return AdminUsageOut(
        serpapi_remaining=remaining,
        daily_budget=budget,
        month_calls=month_calls or 0,
        checked_today=checked_today or 0,
        instant_today=instant_used,
        # 與 prices/instant.py 的全站上限同一個公式
        instant_remaining=max(0, budget - slots_used - instant_used)
        if budget is not None
        else None,
        slots_used=slots_used,
        slots_max=MAX_ACTIVE_QUERIES,
        queued=queued or 0,
        email_sent=emails.get("sent", 0),
        email_failed=emails.get("failed", 0),
        email_pending=emails.get("pending", 0),
    )
