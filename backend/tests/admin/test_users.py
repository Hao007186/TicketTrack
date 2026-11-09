from datetime import UTC, datetime

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from tests.admin.conftest import admin_headers, auth_headers, demo_headers, insert_watch
from tests.conftest import create_user

URL = "/api/v1/admin/users"


async def test_requires_login(client: AsyncClient) -> None:
    assert (await client.get(URL)).status_code == 401


async def test_user_forbidden(client: AsyncClient, db_session: AsyncSession) -> None:
    headers = await auth_headers(client, db_session)
    resp = await client.get(URL, headers=headers)
    assert resp.status_code == 403
    assert resp.json()["detail"] == "需要管理員權限"


async def test_demo_forbidden(client: AsyncClient, db_session: AsyncSession) -> None:
    headers = await demo_headers(client, db_session)
    resp = await client.get(URL, headers=headers)
    assert resp.status_code == 403
    assert resp.json()["detail"] == "需要管理員權限"


async def test_list_users(client: AsyncClient, db_session: AsyncSession) -> None:
    headers = await admin_headers(client, db_session)
    alice = await create_user(db_session, email="alice@example.com")
    alice.created_at = datetime(2026, 11, 2, tzinfo=UTC)
    bob = await create_user(db_session, email="bob@example.com", is_active=False)
    bob.created_at = datetime(2026, 11, 3, tzinfo=UTC)
    await db_session.flush()
    await insert_watch(db_session, alice, status="active")
    await insert_watch(db_session, alice, status="queued", destination="KIX")
    await insert_watch(db_session, alice, status="paused", destination="ICN")

    resp = await client.get(URL, headers=headers)
    assert resp.status_code == 200
    rows = resp.json()
    assert [r["email"] for r in rows] == [
        "admin@example.com",
        "bob@example.com",
        "alice@example.com",
    ]
    by_email = {r["email"]: r for r in rows}
    assert by_email["alice@example.com"]["slot_count"] == 2
    # 停用時全部都會刪掉，確認視窗要用這個數字
    assert by_email["alice@example.com"]["watch_count"] == 3
    assert by_email["bob@example.com"]["slot_count"] == 0
    assert by_email["bob@example.com"]["is_active"] is False
    assert by_email["admin@example.com"]["role"] == "admin"
    for r in rows:
        assert "public_id" in r
        assert "id" not in r
