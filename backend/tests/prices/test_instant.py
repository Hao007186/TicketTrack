import asyncio
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.notifications.email import EmailMessage
from app.modules.notifications.messages import QUOTA_TITLE
from app.modules.notifications.models import Notification
from app.modules.prices import instant
from app.modules.prices.checker import run_checks
from app.modules.prices.instant import InstantResult, check_query, check_watch, reserve_slot
from app.modules.prices.models import InstantCheckUsage, PriceSnapshot
from app.modules.prices.providers.base import ProviderError, SearchResult
from app.modules.users.models import User
from app.modules.watches.models import PriceQuery, Watch
from app.modules.watches.slots import QueryConditions
from tests.conftest import create_user
from tests.notifications.test_notifier import FakeSender
from tests.prices.conftest import TODAY, FakeProvider, insert_watch

# 台灣時間 2026-11-01 10:00
NOW = datetime(2026, 11, 1, 2, 0, tzinfo=UTC)
BASE_URL = "https://hao007186.test"


class HangingProvider(FakeProvider):
    async def search(self, cond: QueryConditions) -> SearchResult:
        await asyncio.sleep(30)
        raise AssertionError("應該先逾時")


async def _setup(session: AsyncSession, **watch_args: Any) -> tuple[User, Watch]:
    user = await create_user(session)
    return user, await insert_watch(session, user, **watch_args)


async def _check(
    session: AsyncSession,
    watch: Watch,
    provider: FakeProvider,
    sender: FakeSender | None = None,
    today: date = TODAY,
) -> InstantResult:
    return await check_watch(
        session, provider, sender or FakeSender(), BASE_URL, watch, today, now=lambda: NOW
    )


async def _used(session: AsyncSession, user_id: int) -> int:
    count = await session.scalar(
        select(InstantCheckUsage.count)
        .where(InstantCheckUsage.user_id == user_id, InstantCheckUsage.day == TODAY)
        .execution_options(populate_existing=True)
    )
    return count or 0


async def _last_checked(session: AsyncSession, query_id: int) -> datetime | None:
    return await session.scalar(
        select(PriceQuery.last_checked_at)
        .where(PriceQuery.id == query_id)
        .execution_options(populate_existing=True)
    )


async def _set_checked(session: AsyncSession, query_id: int, at: datetime | None) -> None:
    await session.execute(
        update(PriceQuery).where(PriceQuery.id == query_id).values(last_checked_at=at)
    )


async def test_checked_records_price_and_counts(db_session: AsyncSession) -> None:
    user, watch = await _setup(db_session)
    provider = FakeProvider()

    assert await _check(db_session, watch, provider) == "checked"

    assert len(provider.calls) == 1
    assert await db_session.scalar(select(func.count()).select_from(PriceSnapshot)) == 1
    assert await _used(db_session, user.id) == 1
    assert await _last_checked(db_session, watch.price_query_id) == NOW


async def test_no_result_still_counts(db_session: AsyncSession) -> None:
    user, watch = await _setup(db_session)
    provider = FakeProvider(default=SearchResult(None, None, None))

    assert await _check(db_session, watch, provider) == "no_result"

    assert await _used(db_session, user.id) == 1
    assert await db_session.scalar(select(func.count()).select_from(PriceSnapshot)) == 0


async def test_already_checked_today_is_free(db_session: AsyncSession) -> None:
    user, watch = await _setup(db_session)
    await _set_checked(db_session, watch.price_query_id, NOW - timedelta(hours=1))
    provider = FakeProvider()

    assert await _check(db_session, watch, provider) == "already_checked"

    assert provider.calls == []
    assert await _used(db_session, user.id) == 0


async def test_checked_yesterday_taipei_is_not_already_checked(db_session: AsyncSession) -> None:
    _, watch = await _setup(db_session)
    # 台灣時間 10/31 23:59 = UTC 10/31 15:59；11/01 00:00 才算今天
    await _set_checked(db_session, watch.price_query_id, datetime(2026, 10, 31, 15, 59, tzinfo=UTC))
    assert await _check(db_session, watch, FakeProvider()) == "checked"


async def test_checked_after_taipei_midnight_is_today(db_session: AsyncSession) -> None:
    _, watch = await _setup(db_session)
    # UTC 還是 10/31，但台灣時間已經是 11/01 00:01
    await _set_checked(db_session, watch.price_query_id, datetime(2026, 10, 31, 16, 1, tzinfo=UTC))
    assert await _check(db_session, watch, FakeProvider()) == "already_checked"


@pytest.mark.parametrize("status", ["paused", "queued", "expired"])
async def test_not_eligible_status(db_session: AsyncSession, status: str) -> None:
    user, watch = await _setup(db_session, status=status)
    provider = FakeProvider()

    assert await _check(db_session, watch, provider) == "not_eligible"

    assert provider.calls == []
    assert await _used(db_session, user.id) == 0


async def test_not_eligible_near_departure(db_session: AsyncSession) -> None:
    _, watch = await _setup(db_session, depart_date=TODAY + timedelta(days=2), return_date=None)
    provider = FakeProvider()
    assert await _check(db_session, watch, provider) == "not_eligible"
    assert provider.calls == []


async def test_user_limit_does_not_search(db_session: AsyncSession) -> None:
    user, watch = await _setup(db_session)
    for _ in range(3):
        await reserve_slot(db_session, user.id, TODAY, None)
    provider = FakeProvider()

    assert await _check(db_session, watch, provider) == "user_limit"

    assert provider.calls == []
    assert await _last_checked(db_session, watch.price_query_id) is None


async def test_site_limit_uses_daily_budget(db_session: AsyncSession) -> None:
    other = await create_user(db_session, email="bob@example.com")
    await reserve_slot(db_session, other.id, TODAY, None)
    user, watch = await _setup(db_session)
    # 11/1 還有 30 天；剩 30 次時每日預算是 1，已被 bob 用掉
    provider = FakeProvider(remaining=30)

    assert await _check(db_session, watch, provider) == "site_limit"

    assert provider.calls == []
    assert await _used(db_session, user.id) == 0


async def test_quota_exhausted_notifies(db_session: AsyncSession) -> None:
    user, watch = await _setup(db_session)
    provider = FakeProvider(remaining=0)

    assert await _check(db_session, watch, provider) == "quota_exhausted"

    assert provider.calls == []
    assert await _used(db_session, user.id) == 0
    titles = await db_session.scalars(
        select(Notification.title).where(Notification.user_id == user.id)
    )
    assert list(titles) == [QUOTA_TITLE]


async def test_remaining_failure_is_failed(db_session: AsyncSession) -> None:
    user, watch = await _setup(db_session)
    provider = FakeProvider(remaining=ProviderError("account 掛了"))

    assert await _check(db_session, watch, provider) == "failed"

    assert provider.calls == []
    assert await _used(db_session, user.id) == 0


async def test_search_failure_refunds_and_restores(db_session: AsyncSession) -> None:
    user, watch = await _setup(db_session)
    provider = FakeProvider(default=ProviderError("search 掛了"))

    assert await _check(db_session, watch, provider) == "failed"

    assert await _used(db_session, user.id) == 0
    assert await _last_checked(db_session, watch.price_query_id) is None


async def test_timeout_refunds_and_restores(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(instant, "INSTANT_TIMEOUT_SECONDS", 0.01)
    user, watch = await _setup(db_session)

    assert await _check(db_session, watch, HangingProvider()) == "failed"

    assert await _used(db_session, user.id) == 0
    assert await _last_checked(db_session, watch.price_query_id) is None


async def test_lost_claim_refunds(db_session: AsyncSession) -> None:
    user, watch = await _setup(db_session)

    async def someone_else_checks() -> None:
        await _set_checked(db_session, watch.price_query_id, NOW)

    provider = FakeProvider(on_remaining=someone_else_checks)

    assert await _check(db_session, watch, provider) == "already_checked"

    assert provider.calls == []
    assert await _used(db_session, user.id) == 0


async def test_daily_job_skips_after_instant_check(db_session: AsyncSession) -> None:
    _, watch = await _setup(db_session)
    provider = FakeProvider()
    await _check(db_session, watch, provider)

    await run_checks(db_session, provider, TODAY, now=lambda: NOW)

    assert len(provider.calls) == 1


async def test_sends_email_after_check(db_session: AsyncSession) -> None:
    _, watch = await _setup(db_session, target_price=9500)
    sender = FakeSender()

    assert await _check(db_session, watch, FakeProvider(), sender) == "checked"

    assert [m.to for m in sender.attempts] == ["alice@example.com"]


async def test_email_failure_keeps_result(db_session: AsyncSession) -> None:
    class BrokenSender(FakeSender):
        async def send(self, message: EmailMessage) -> None:
            raise RuntimeError("SES 權限不足")

    user, watch = await _setup(db_session, target_price=9500)
    user_id = user.id

    assert await _check(db_session, watch, FakeProvider(), BrokenSender()) == "checked"

    # 查價結果和次數都留著
    assert await db_session.scalar(select(func.count()).select_from(PriceSnapshot)) == 1
    assert await _used(db_session, user_id) == 1


async def test_check_query_without_watch(db_session: AsyncSession) -> None:
    """表單查價還沒有追蹤，只有 query。"""
    user, watch = await _setup(db_session, status="paused")
    provider = FakeProvider()

    result = await check_query(
        db_session,
        provider,
        FakeSender(),
        BASE_URL,
        user.id,
        watch.price_query,
        TODAY,
        now=lambda: NOW,
    )

    assert result == "checked"
    assert len(provider.calls) == 1
