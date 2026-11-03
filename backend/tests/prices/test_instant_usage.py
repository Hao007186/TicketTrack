import asyncio
from datetime import timedelta

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.modules.prices.instant import refund_slot, reserve_slot
from app.modules.prices.models import InstantCheckUsage
from app.modules.users.models import User
from tests.conftest import create_user
from tests.prices.conftest import TODAY


async def _count(session: AsyncSession, user_id: int) -> int:
    count = await session.scalar(
        select(InstantCheckUsage.count)
        .where(InstantCheckUsage.user_id == user_id, InstantCheckUsage.day == TODAY)
        .execution_options(populate_existing=True)
    )
    return count or 0


async def test_fourth_reserve_is_user_limit(db_session: AsyncSession) -> None:
    user = await create_user(db_session)
    for _ in range(3):
        assert await reserve_slot(db_session, user.id, TODAY, None) == "ok"
    assert await reserve_slot(db_session, user.id, TODAY, None) == "user_limit"
    assert await _count(db_session, user.id) == 3


async def test_other_user_and_next_day_are_independent(db_session: AsyncSession) -> None:
    alice = await create_user(db_session)
    bob = await create_user(db_session, email="bob@example.com")
    for _ in range(3):
        await reserve_slot(db_session, alice.id, TODAY, None)
    assert await reserve_slot(db_session, bob.id, TODAY, None) == "ok"
    assert await reserve_slot(db_session, alice.id, TODAY + timedelta(days=1), None) == "ok"


async def test_site_limit_counts_all_users(db_session: AsyncSession) -> None:
    alice = await create_user(db_session)
    bob = await create_user(db_session, email="bob@example.com")
    carol = await create_user(db_session, email="carol@example.com")
    await reserve_slot(db_session, alice.id, TODAY, 2)
    await reserve_slot(db_session, bob.id, TODAY, 2)
    assert await reserve_slot(db_session, carol.id, TODAY, 2) == "site_limit"
    assert await _count(db_session, carol.id) == 0


async def test_site_limit_ignores_other_days(db_session: AsyncSession) -> None:
    alice = await create_user(db_session)
    await reserve_slot(db_session, alice.id, TODAY - timedelta(days=1), 1)
    assert await reserve_slot(db_session, alice.id, TODAY, 1) == "ok"


async def test_none_budget_skips_site_limit(db_session: AsyncSession) -> None:
    for i in range(4):
        user = await create_user(db_session, email=f"u{i}@example.com")
        assert await reserve_slot(db_session, user.id, TODAY, None) == "ok"


async def test_refund_gives_slot_back(db_session: AsyncSession) -> None:
    user = await create_user(db_session)
    for _ in range(3):
        await reserve_slot(db_session, user.id, TODAY, None)
    await refund_slot(db_session, user.id, TODAY)
    assert await _count(db_session, user.id) == 2
    assert await reserve_slot(db_session, user.id, TODAY, None) == "ok"


async def test_concurrent_reserves_never_exceed_limit(engine: AsyncEngine) -> None:
    # db_session 共用同一條連線測不到鎖，這裡用獨立連線，所以資料真的會 commit，最後要自己刪
    async with AsyncSession(engine, expire_on_commit=False) as setup:
        user = await create_user(setup, email="concurrent@example.com")
        await setup.commit()

    async def reserve() -> str:
        async with AsyncSession(engine, expire_on_commit=False) as session:
            return await reserve_slot(session, user.id, TODAY, None)

    try:
        results = await asyncio.gather(*(reserve() for _ in range(6)))
        assert results.count("ok") == 3
        assert results.count("user_limit") == 3
    finally:
        async with AsyncSession(engine) as cleanup:
            await cleanup.execute(delete(User).where(User.id == user.id))
            await cleanup.commit()
