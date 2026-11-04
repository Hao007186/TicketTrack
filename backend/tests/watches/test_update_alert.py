"""只改目標價時，用最近的價格立刻判斷：PATCH /watches/{id} 的整條流程。"""

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient, Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.notifications.email import EmailMessage
from app.modules.notifications.models import Notification
from app.modules.prices.deps import get_sender
from app.modules.prices.models import PriceSnapshot
from app.modules.users.models import User
from app.modules.watches.models import Watch
from tests.notifications.test_notifier import FakeSender
from tests.watches.conftest import auth_headers, insert_watch

URL = "/api/v1/watches"


@pytest.fixture
def sender(app: FastAPI) -> FakeSender:
    fake = FakeSender()
    app.dependency_overrides[get_sender] = lambda: fake
    return fake


async def _alice(session: AsyncSession) -> User:
    user = await session.scalar(select(User).where(User.email == "alice@example.com"))
    assert user is not None
    return user


async def _watch_with_price(
    session: AsyncSession,
    *,
    age: timedelta = timedelta(hours=1),
    status: str = "active",
) -> Watch:
    """目前最低價 9000，目標價 8000（還沒達標）。"""
    watch = await insert_watch(session, await _alice(session), target_price=8000, status=status)
    session.add(
        PriceSnapshot(
            price_query_id=watch.price_query_id,
            provider="fake",
            price=9000,
            stops=0,
            observed_at=datetime.now(UTC) - age,
        )
    )
    await session.flush()
    return watch


async def _patch(
    client: AsyncClient, headers: dict[str, str], watch: Watch, **payload: Any
) -> Response:
    return await client.patch(f"{URL}/{watch.public_id}", json=payload, headers=headers)


async def _notifications(session: AsyncSession) -> int:
    return await session.scalar(select(func.count()).select_from(Notification)) or 0


async def test_raising_target_above_recent_price_notifies_now(
    client: AsyncClient, db_session: AsyncSession, sender: FakeSender
) -> None:
    headers = await auth_headers(client, db_session)
    watch = await _watch_with_price(db_session)

    resp = await _patch(client, headers, watch, target_price=9500)

    assert resp.status_code == 200
    assert resp.json()["target_price"] == 9500
    assert await _notifications(db_session) == 1
    assert [m.to for m in sender.attempts] == ["alice@example.com"]


async def test_target_still_below_recent_price_does_not_notify(
    client: AsyncClient, db_session: AsyncSession, sender: FakeSender
) -> None:
    headers = await auth_headers(client, db_session)
    watch = await _watch_with_price(db_session)

    resp = await _patch(client, headers, watch, target_price=8500)

    assert resp.status_code == 200
    assert await _notifications(db_session) == 0
    assert sender.attempts == []


async def test_stale_price_waits_for_daily_check(
    client: AsyncClient, db_session: AsyncSession, sender: FakeSender
) -> None:
    headers = await auth_headers(client, db_session)
    watch = await _watch_with_price(db_session, age=timedelta(hours=25))

    resp = await _patch(client, headers, watch, target_price=9500)

    assert resp.status_code == 200
    assert await _notifications(db_session) == 0


async def test_paused_watch_does_not_notify(
    client: AsyncClient, db_session: AsyncSession, sender: FakeSender
) -> None:
    headers = await auth_headers(client, db_session)
    watch = await _watch_with_price(db_session, status="paused")

    resp = await _patch(client, headers, watch, target_price=9500)

    assert resp.status_code == 200
    assert await _notifications(db_session) == 0


async def test_pausing_in_same_request_does_not_notify(
    client: AsyncClient, db_session: AsyncSession, sender: FakeSender
) -> None:
    headers = await auth_headers(client, db_session)
    watch = await _watch_with_price(db_session)

    resp = await _patch(client, headers, watch, target_price=9500, status="paused")

    assert resp.status_code == 200
    assert await _notifications(db_session) == 0


async def test_changing_conditions_too_is_left_to_instant_check(
    client: AsyncClient, db_session: AsyncSession, sender: FakeSender
) -> None:
    headers = await auth_headers(client, db_session)
    watch = await _watch_with_price(db_session)

    resp = await _patch(client, headers, watch, target_price=9500, destination="KIX")

    assert resp.status_code == 200
    assert await _notifications(db_session) == 0


async def test_same_target_does_not_notify(
    client: AsyncClient, db_session: AsyncSession, sender: FakeSender
) -> None:
    headers = await auth_headers(client, db_session)
    watch = await insert_watch(db_session, await _alice(db_session), target_price=9500)
    db_session.add(
        PriceSnapshot(
            price_query_id=watch.price_query_id,
            provider="fake",
            price=9000,
            stops=0,
            observed_at=datetime.now(UTC) - timedelta(hours=1),
        )
    )
    await db_session.flush()

    resp = await _patch(client, headers, watch, target_price=9500)

    assert resp.status_code == 200
    assert await _notifications(db_session) == 0


async def test_changing_target_back_and_forth_only_notifies_once(
    client: AsyncClient, db_session: AsyncSession, sender: FakeSender
) -> None:
    headers = await auth_headers(client, db_session)
    watch = await _watch_with_price(db_session)

    await _patch(client, headers, watch, target_price=9500)
    await _patch(client, headers, watch, target_price=8000)
    await _patch(client, headers, watch, target_price=9600)

    assert await _notifications(db_session) == 1
    assert len(sender.attempts) == 1


async def test_email_failure_keeps_update_and_notification(
    app: FastAPI, client: AsyncClient, db_session: AsyncSession
) -> None:
    class BrokenSender(FakeSender):
        async def send(self, message: EmailMessage) -> None:
            raise RuntimeError("SES 權限不足")

    app.dependency_overrides[get_sender] = BrokenSender
    headers = await auth_headers(client, db_session)
    watch = await _watch_with_price(db_session)

    resp = await _patch(client, headers, watch, target_price=9500)

    assert resp.status_code == 200
    assert resp.json()["target_price"] == 9500
    assert await _notifications(db_session) == 1
