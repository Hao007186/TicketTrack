from datetime import UTC, date, datetime, timedelta

from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import TAIPEI_TZ
from app.modules.alerts.models import Alert, AlertDelivery
from app.modules.prices.deps import get_price_provider
from app.modules.prices.models import ApiUsage, InstantCheckUsage
from app.modules.prices.providers.base import ProviderError
from app.modules.watches.models import Watch
from app.modules.watches.slots import get_or_create_price_query
from tests.admin.conftest import (
    TODAY,
    admin_headers,
    auth_headers,
    conditions,
    fill_slots,
    insert_watch,
)
from tests.conftest import create_user
from tests.prices.conftest import FakeProvider

URL = "/api/v1/admin/usage"
TODAY_NOON = datetime(TODAY.year, TODAY.month, TODAY.day, 12, tzinfo=TAIPEI_TZ)


def use_provider(app: FastAPI, provider: FakeProvider) -> None:
    app.dependency_overrides[get_price_provider] = lambda: provider


async def _instant(session: AsyncSession, user_id: int, day: date, count: int) -> None:
    session.add(InstantCheckUsage(user_id=user_id, day=day, count=count))
    await session.flush()


async def _delivery(session: AsyncSession, watch: Watch, status: str, created_at: datetime) -> None:
    alert = Alert(watch_id=watch.id, reason="below_target", price=1000)
    session.add(alert)
    await session.flush()
    session.add(
        AlertDelivery(alert_id=alert.id, channel="email", status=status, created_at=created_at)
    )
    await session.flush()


async def test_usage_numbers(app: FastAPI, client: AsyncClient, db_session: AsyncSession) -> None:
    use_provider(app, FakeProvider(remaining=270))  # 11 月 30 天 → 每日預算 9
    headers = await admin_headers(client, db_session)
    filler = await fill_slots(db_session, 8)
    waiting = await create_user(db_session, email="wait@example.com")
    await insert_watch(db_session, waiting, status="queued", destination="HND")
    for watch in filler[:2]:
        watch.price_query.last_checked_at = TODAY_NOON
    demo_query = await get_or_create_price_query(
        db_session, conditions(is_demo=True, destination="KIX")
    )
    demo_query.last_checked_at = TODAY_NOON
    yesterday_query = await get_or_create_price_query(
        db_session, conditions(origin="KHH", destination="KIX")
    )
    yesterday_query.last_checked_at = TODAY_NOON - timedelta(days=1)
    await _instant(db_session, filler[0].user_id, TODAY, 1)
    await _instant(db_session, waiting.id, TODAY, 1)
    await _instant(db_session, waiting.id, TODAY - timedelta(days=1), 5)
    db_session.add(ApiUsage(provider="fake", month="2026-11", count=70))
    db_session.add(ApiUsage(provider="fake", month="2026-10", count=99))
    await db_session.flush()

    resp = await client.get(URL, headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["serpapi_remaining"] == 270
    assert body["daily_budget"] == 9
    assert body["month_calls"] == 70
    assert body["checked_today"] == 2
    assert body["instant_today"] == 2
    assert body["instant_remaining"] == 0  # 9 − 8 − 2，不會小於 0
    assert body["slots_used"] == 8
    assert body["slots_max"] == 8
    assert body["queued"] == 1


async def test_usage_instant_remaining_positive(
    app: FastAPI, client: AsyncClient, db_session: AsyncSession
) -> None:
    use_provider(app, FakeProvider(remaining=360))  # 每日預算 12
    headers = await admin_headers(client, db_session)
    filler = await fill_slots(db_session, 8)
    await _instant(db_session, filler[0].user_id, TODAY, 1)

    body = (await client.get(URL, headers=headers)).json()
    assert body["daily_budget"] == 12
    assert body["instant_remaining"] == 3
    assert body["month_calls"] == 0


async def test_usage_provider_failure(
    app: FastAPI, client: AsyncClient, db_session: AsyncSession
) -> None:
    headers = await admin_headers(client, db_session)
    await fill_slots(db_session, 3)
    for failure in (ProviderError("x"), TimeoutError()):
        use_provider(app, FakeProvider(remaining=failure))
        resp = await client.get(URL, headers=headers)
        assert resp.status_code == 200
        body = resp.json()
        assert body["serpapi_remaining"] is None
        assert body["daily_budget"] is None
        assert body["instant_remaining"] is None
        assert body["slots_used"] == 3


async def test_usage_email_counts(
    app: FastAPI, client: AsyncClient, db_session: AsyncSession
) -> None:
    use_provider(app, FakeProvider(remaining=270))
    headers = await admin_headers(client, db_session)
    alice = await create_user(db_session, email="alice@example.com")
    watch = await insert_watch(db_session, alice)
    this_month = TODAY_NOON
    for status in ("sent", "sent", "failed", "pending", "skipped"):
        await _delivery(db_session, watch, status, this_month)
    for _ in range(3):
        await _delivery(db_session, watch, "sent", this_month - timedelta(days=5))

    body = (await client.get(URL, headers=headers)).json()
    assert body["email_sent"] == 2
    assert body["email_failed"] == 1
    assert body["email_pending"] == 1


async def test_usage_email_month_taipei(
    app: FastAPI, client: AsyncClient, db_session: AsyncSession
) -> None:
    use_provider(app, FakeProvider(remaining=270))
    headers = await admin_headers(client, db_session)
    alice = await create_user(db_session, email="alice@example.com")
    watch = await insert_watch(db_session, alice)
    # 台灣 11/01 01:00 算 11 月；台灣 10/31 23:59 不算
    await _delivery(db_session, watch, "sent", datetime(2026, 10, 31, 17, tzinfo=UTC))
    await _delivery(db_session, watch, "sent", datetime(2026, 10, 31, 15, 59, tzinfo=UTC))

    body = (await client.get(URL, headers=headers)).json()
    assert body["email_sent"] == 1


async def test_usage_forbidden(app: FastAPI, client: AsyncClient, db_session: AsyncSession) -> None:
    called: list[bool] = []

    async def record() -> None:
        called.append(True)

    use_provider(app, FakeProvider(remaining=270, on_remaining=record))
    headers = await auth_headers(client, db_session)
    assert (await client.get(URL, headers=headers)).status_code == 403
    assert called == []
