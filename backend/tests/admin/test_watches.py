import uuid
from datetime import UTC, datetime

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User
from app.modules.watches.models import PriceQuery, Watch
from app.seeds.demo import ensure_demo_watches
from tests.admin.conftest import (
    TODAY,
    admin_headers,
    auth_headers,
    demo_headers,
    fill_slots,
    insert_watch,
)
from tests.conftest import create_user

URL = "/api/v1/admin/watches"


async def _demo_watch(client: AsyncClient, session: AsyncSession) -> Watch:
    await demo_headers(client, session)
    demo = await session.scalar(select(User).where(User.is_demo.is_(True)))
    assert demo is not None
    await ensure_demo_watches(session, demo, TODAY)
    watch = await session.scalar(select(Watch).where(Watch.user_id == demo.id).limit(1))
    assert watch is not None
    return watch


async def test_list_watches(client: AsyncClient, db_session: AsyncSession) -> None:
    headers = await admin_headers(client, db_session)
    await _demo_watch(client, db_session)
    alice = await create_user(db_session, email="alice@example.com")
    newer = await insert_watch(
        db_session, alice, created_at=datetime(2026, 10, 20, tzinfo=UTC), destination="KIX"
    )
    older = await insert_watch(
        db_session,
        alice,
        status="queued",
        created_at=datetime(2026, 10, 10, tzinfo=UTC),
        destination="ICN",
    )
    await insert_watch(db_session, alice, status="paused", destination="HKG")
    await insert_watch(db_session, alice, status="expired", destination="BKK")

    resp = await client.get(URL, headers=headers)
    assert resp.status_code == 200
    rows = resp.json()
    assert [r["public_id"] for r in rows] == [str(older.public_id), str(newer.public_id)]
    assert rows[0]["owner_email"] == "alice@example.com"
    assert rows[0]["status"] == "queued"
    assert rows[0]["origin"] == "TPE"
    assert rows[0]["destination"] == "ICN"
    assert "id" not in rows[0]


async def test_delete_any_watch_promotes(client: AsyncClient, db_session: AsyncSession) -> None:
    headers = await admin_headers(client, db_session)
    filler = await fill_slots(db_session, 8)
    alice = await create_user(db_session, email="alice@example.com")
    queued = await insert_watch(db_session, alice, status="queued", destination="PUS")

    resp = await client.delete(f"{URL}/{filler[0].public_id}", headers=headers)
    assert resp.status_code == 204
    assert await db_session.scalar(select(Watch).where(Watch.id == filler[0].id)) is None
    status = await db_session.scalar(
        select(Watch.status).where(Watch.id == queued.id).execution_options(populate_existing=True)
    )
    assert status == "active"
    # price_query 保留，價格歷史還掛在上面
    assert await db_session.get(PriceQuery, filler[0].price_query_id) is not None


async def test_delete_demo_watch_409(client: AsyncClient, db_session: AsyncSession) -> None:
    watch = await _demo_watch(client, db_session)
    headers = await admin_headers(client, db_session)
    resp = await client.delete(f"{URL}/{watch.public_id}", headers=headers)
    assert resp.status_code == 409
    assert resp.json()["detail"] == "不能刪除示範帳號的追蹤"


async def test_delete_unknown_404(client: AsyncClient, db_session: AsyncSession) -> None:
    headers = await admin_headers(client, db_session)
    resp = await client.delete(f"{URL}/{uuid.uuid4()}", headers=headers)
    assert resp.status_code == 404
    assert resp.json()["detail"] == "找不到追蹤"


async def test_non_admin_forbidden(client: AsyncClient, db_session: AsyncSession) -> None:
    headers = await auth_headers(client, db_session)
    alice = await db_session.scalar(select(User).where(User.email == "alice@example.com"))
    assert alice is not None
    watch = await insert_watch(db_session, alice)
    assert (await client.get(URL, headers=headers)).status_code == 403
    assert (await client.delete(f"{URL}/{watch.public_id}", headers=headers)).status_code == 403
