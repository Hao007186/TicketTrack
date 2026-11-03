"""立即查價：建立或修改追蹤後、表單填目標價前，不等排程先查一次。"""

from datetime import date
from typing import Literal

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.prices.models import InstantCheckUsage

MAX_INSTANT_CHECKS_PER_DAY = 3
# pg_advisory_xact_lock 的鍵，和 slots.WATCH_LOCK_KEY 分開："FARF" 的 ASCII
INSTANT_LOCK_KEY = 0x46415246


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
