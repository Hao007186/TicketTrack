import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.prices.checker import due_queries
from app.modules.prices.deps import get_price_provider, get_sender
from app.modules.prices.models import InstantCheckUsage, PriceSnapshot
from app.modules.prices.providers.base import Insights, Offer, SearchResult
from app.modules.users.models import User
from app.modules.watches.models import PriceQuery
from app.modules.watches.slots import occupied_query_ids
from tests.conftest import create_user
from tests.notifications.test_notifier import FakeSender
from tests.prices.conftest import TODAY, FakeProvider, auth_headers, demo_headers, insert_watch

PREVIEW_URL = "/api/v1/price-reference/check"
DEPART = (TODAY + timedelta(days=30)).isoformat()
BODY: dict[str, Any] = {"origin": "TPE", "destination": "NRT", "depart_date": DEPART}
WITH_INSIGHTS = SearchResult(
    Offer(9200, "BR", 0),
    "https://example.test",
    Insights(typical_low=8200, typical_high=11500, history_low=None),
)


@pytest.fixture
def provider(app: FastAPI) -> FakeProvider:
    fake = FakeProvider()
    app.dependency_overrides[get_price_provider] = lambda: fake
    app.dependency_overrides[get_sender] = FakeSender
    return fake


def _check_url(public_id: object) -> str:
    return f"/api/v1/watches/{public_id}/check"


async def _alice(session: AsyncSession) -> User:
    user = await session.scalar(select(User).where(User.email == "alice@example.com"))
    assert user is not None
    return user


async def test_check_watch_returns_result(
    client: AsyncClient, db_session: AsyncSession, provider: FakeProvider
) -> None:
    headers = await auth_headers(client, db_session)
    watch = await insert_watch(db_session, await _alice(db_session))

    resp = await client.post(_check_url(watch.public_id), headers=headers)

    assert resp.status_code == 200
    assert resp.json() == {"result": "checked"}
    assert len(provider.calls) == 1


async def test_check_requires_auth(client: AsyncClient, provider: FakeProvider) -> None:
    assert (await client.post(_check_url(uuid.uuid4()))).status_code == 401
    assert (await client.post(PREVIEW_URL, json=BODY)).status_code == 401


async def test_demo_cannot_check(
    client: AsyncClient, db_session: AsyncSession, provider: FakeProvider
) -> None:
    headers = await demo_headers(client, db_session)

    assert (await client.post(_check_url(uuid.uuid4()), headers=headers)).status_code == 403
    assert (await client.post(PREVIEW_URL, json=BODY, headers=headers)).status_code == 403
    assert provider.calls == []


async def test_other_users_watch_404(
    client: AsyncClient, db_session: AsyncSession, provider: FakeProvider
) -> None:
    headers = await auth_headers(client, db_session)
    bob = await create_user(db_session, email="bob@example.com")
    watch = await insert_watch(db_session, bob)

    resp = await client.post(_check_url(watch.public_id), headers=headers)

    assert resp.status_code == 404
    assert provider.calls == []


async def test_preview_returns_prices(
    client: AsyncClient, db_session: AsyncSession, provider: FakeProvider
) -> None:
    provider.default = WITH_INSIGHTS
    headers = await auth_headers(client, db_session)

    resp = await client.post(PREVIEW_URL, json=BODY, headers=headers)

    assert resp.status_code == 200
    assert resp.json() == {
        "result": "checked",
        "lowest_price": 9200,
        "typical_low": 8200,
        "typical_high": 11500,
    }


async def test_preview_without_insights(
    client: AsyncClient, db_session: AsyncSession, provider: FakeProvider
) -> None:
    headers = await auth_headers(client, db_session)

    body = (await client.post(PREVIEW_URL, json=BODY, headers=headers)).json()

    assert body == {
        "result": "checked",
        "lowest_price": 9000,
        "typical_low": None,
        "typical_high": None,
    }


async def test_preview_no_flights(
    client: AsyncClient, db_session: AsyncSession, provider: FakeProvider
) -> None:
    provider.default = SearchResult(None, None, None)
    headers = await auth_headers(client, db_session)

    body = (await client.post(PREVIEW_URL, json=BODY, headers=headers)).json()

    assert body["result"] == "no_result"
    assert body["lowest_price"] is None


async def test_preview_invalid_conditions_422(
    client: AsyncClient, db_session: AsyncSession, provider: FakeProvider
) -> None:
    headers = await auth_headers(client, db_session)
    too_soon = {**BODY, "depart_date": (TODAY + timedelta(days=1)).isoformat()}

    resp = await client.post(PREVIEW_URL, json=too_soon, headers=headers)

    assert resp.status_code == 422
    assert "出發日" in resp.json()["detail"]
    assert provider.calls == []
    assert await db_session.scalar(select(func.count()).select_from(InstantCheckUsage)) == 0
    assert await db_session.scalar(select(func.count()).select_from(PriceQuery)) == 0


async def test_preview_shares_count_with_watch_check(
    client: AsyncClient, db_session: AsyncSession, provider: FakeProvider
) -> None:
    headers = await auth_headers(client, db_session)
    watch = await insert_watch(db_session, await _alice(db_session), destination="HKG")
    await client.post(PREVIEW_URL, json=BODY, headers=headers)
    await client.post(PREVIEW_URL, json={**BODY, "destination": "KIX"}, headers=headers)
    await client.post(_check_url(watch.public_id), headers=headers)

    body = (
        await client.post(PREVIEW_URL, json={**BODY, "destination": "ICN"}, headers=headers)
    ).json()

    assert body == {
        "result": "user_limit",
        "lowest_price": None,
        "typical_low": None,
        "typical_high": None,
    }
    assert len(provider.calls) == 3


async def test_preview_only_query_not_due_and_no_slot(
    client: AsyncClient, db_session: AsyncSession, provider: FakeProvider
) -> None:
    headers = await auth_headers(client, db_session)
    await client.post(PREVIEW_URL, json=BODY, headers=headers)

    query = await db_session.scalar(select(PriceQuery))
    assert query is not None
    # 當天查過，所以排程本來就不會查；清掉時間才測得出「沒有追蹤就不查」
    await db_session.execute(update(PriceQuery).values(last_checked_at=None))
    assert await due_queries(db_session, TODAY) == []
    assert await occupied_query_ids(db_session, TODAY) == set()


async def test_preview_then_create_is_free(
    client: AsyncClient, db_session: AsyncSession, provider: FakeProvider
) -> None:
    headers = await auth_headers(client, db_session)
    await client.post(PREVIEW_URL, json=BODY, headers=headers)

    created = await client.post(
        "/api/v1/watches", json={**BODY, "target_price": 9500}, headers=headers
    )
    assert created.status_code == 201
    resp = await client.post(_check_url(created.json()["public_id"]), headers=headers)

    assert resp.json() == {"result": "already_checked"}
    assert len(provider.calls) == 1


async def test_preview_repeat_is_free_and_returns_price(
    client: AsyncClient, db_session: AsyncSession, provider: FakeProvider
) -> None:
    provider.default = WITH_INSIGHTS
    headers = await auth_headers(client, db_session)
    await client.post(PREVIEW_URL, json=BODY, headers=headers)

    body = (await client.post(PREVIEW_URL, json=BODY, headers=headers)).json()

    assert body == {
        "result": "already_checked",
        "lowest_price": 9200,
        "typical_low": 8200,
        "typical_high": 11500,
    }
    assert len(provider.calls) == 1


async def test_preview_already_checked_ignores_old_snapshot(
    client: AsyncClient, db_session: AsyncSession, provider: FakeProvider
) -> None:
    headers = await auth_headers(client, db_session)
    watch = await insert_watch(db_session, await _alice(db_session))
    db_session.add(
        PriceSnapshot(
            price_query_id=watch.price_query_id,
            provider="mock",
            price=7000,
            stops=0,
            observed_at=datetime(2026, 10, 31, 2, 0, tzinfo=UTC),
        )
    )
    # 今天查過但沒有今天的價格（例如查無航班）
    await db_session.execute(
        update(PriceQuery)
        .where(PriceQuery.id == watch.price_query_id)
        .values(last_checked_at=datetime(2026, 11, 1, 2, 0, tzinfo=UTC))
    )

    body = (await client.post(PREVIEW_URL, json=BODY, headers=headers)).json()

    assert body["result"] == "already_checked"
    assert body["lowest_price"] is None
    assert provider.calls == []
