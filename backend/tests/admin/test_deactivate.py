import uuid

from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.auth.models import RefreshToken
from app.modules.users.models import User
from app.modules.watches.models import Watch
from tests.admin.conftest import (
    admin_headers,
    auth_headers,
    demo_headers,
    fill_slots,
    insert_watch,
)
from tests.auth.conftest import cookie_token, refresh_with
from tests.conftest import create_user

URL = "/api/v1/admin/users"
LOGIN_URL = "/api/v1/auth/login"


async def _user(session: AsyncSession, email: str) -> User:
    user = await session.scalar(select(User).where(User.email == email))
    assert user is not None
    return user


async def _status(session: AsyncSession, watch: Watch) -> str | None:
    return await session.scalar(
        select(Watch.status).where(Watch.id == watch.id).execution_options(populate_existing=True)
    )


async def _watch_count(session: AsyncSession, user: User) -> int:
    return (
        await session.scalar(
            select(func.count()).select_from(Watch).where(Watch.user_id == user.id)
        )
        or 0
    )


async def test_deactivate_deletes_watches_and_promotes(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    headers = await admin_headers(client, db_session)
    alice = await create_user(db_session, email="alice@example.com")
    await fill_slots(db_session, 7)
    await insert_watch(db_session, alice, destination="TPE")
    await insert_watch(db_session, alice, status="paused", destination="KIX")
    await insert_watch(db_session, alice, status="expired", destination="ICN")
    waiting = await create_user(db_session, email="wait@example.com")
    queued = await insert_watch(db_session, waiting, status="queued", destination="PUS")

    resp = await client.post(f"{URL}/{alice.public_id}/deactivate", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["is_active"] is False
    assert body["slot_count"] == 0
    assert await _watch_count(db_session, alice) == 0
    assert await _status(db_session, queued) == "active"


async def test_deactivate_deletes_refresh_tokens(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    alice = await create_user(db_session, email="alice@example.com")
    login = await client.post(
        LOGIN_URL, json={"email": "alice@example.com", "password": "correct-horse"}
    )
    token = cookie_token(login)
    client.cookies.clear()
    headers = await admin_headers(client, db_session)

    resp = await client.post(f"{URL}/{alice.public_id}/deactivate", headers=headers)
    assert resp.status_code == 200
    remaining = await db_session.scalar(
        select(func.count()).select_from(RefreshToken).where(RefreshToken.user_id == alice.id)
    )
    assert remaining == 0
    assert (await refresh_with(client, token)).status_code == 401


async def test_deactivated_token_rejected(client: AsyncClient, db_session: AsyncSession) -> None:
    alice_headers = await auth_headers(client, db_session)
    alice = await _user(db_session, "alice@example.com")
    headers = await admin_headers(client, db_session)

    await client.post(f"{URL}/{alice.public_id}/deactivate", headers=headers)
    assert (await client.get("/api/v1/me", headers=alice_headers)).status_code == 401


async def test_deactivate_keeps_shared_query_occupied(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    headers = await admin_headers(client, db_session)
    alice = await create_user(db_session, email="alice@example.com")
    carol = await create_user(db_session, email="carol@example.com")
    await insert_watch(db_session, alice)
    shared = await insert_watch(db_session, carol)
    await fill_slots(db_session, 7)
    dave = await create_user(db_session, email="dave@example.com")
    waiting = await insert_watch(db_session, dave, status="queued", destination="PUS")

    resp = await client.post(f"{URL}/{alice.public_id}/deactivate", headers=headers)
    assert resp.status_code == 200
    assert await _status(db_session, shared) == "active"
    assert await _status(db_session, waiting) == "queued"


async def test_cannot_deactivate_self(client: AsyncClient, db_session: AsyncSession) -> None:
    headers = await admin_headers(client, db_session)
    admin = await _user(db_session, "admin@example.com")
    resp = await client.post(f"{URL}/{admin.public_id}/deactivate", headers=headers)
    assert resp.status_code == 409
    assert resp.json()["detail"] == "不能停用自己的帳號"


async def test_cannot_deactivate_demo(client: AsyncClient, db_session: AsyncSession) -> None:
    await demo_headers(client, db_session)
    demo = await db_session.scalar(select(User).where(User.is_demo.is_(True)))
    assert demo is not None
    headers = await admin_headers(client, db_session)
    resp = await client.post(f"{URL}/{demo.public_id}/deactivate", headers=headers)
    assert resp.status_code == 409
    assert resp.json()["detail"] == "不能停用示範帳號"


async def test_cannot_deactivate_admin(client: AsyncClient, db_session: AsyncSession) -> None:
    headers = await admin_headers(client, db_session)
    other = await create_user(db_session, email="admin2@example.com", role="admin")
    resp = await client.post(f"{URL}/{other.public_id}/deactivate", headers=headers)
    assert resp.status_code == 409
    assert resp.json()["detail"] == "不能停用管理員帳號"


async def test_deactivate_twice(client: AsyncClient, db_session: AsyncSession) -> None:
    headers = await admin_headers(client, db_session)
    bob = await create_user(db_session, email="bob@example.com", is_active=False)
    resp = await client.post(f"{URL}/{bob.public_id}/deactivate", headers=headers)
    assert resp.status_code == 409
    assert resp.json()["detail"] == "帳號已經是停用狀態"


async def test_deactivate_unknown_404(client: AsyncClient, db_session: AsyncSession) -> None:
    headers = await admin_headers(client, db_session)
    resp = await client.post(f"{URL}/{uuid.uuid4()}/deactivate", headers=headers)
    assert resp.status_code == 404
    assert resp.json()["detail"] == "找不到帳號"


async def test_reactivate(client: AsyncClient, db_session: AsyncSession) -> None:
    headers = await admin_headers(client, db_session)
    alice = await create_user(db_session, email="alice@example.com")
    await insert_watch(db_session, alice)
    await client.post(f"{URL}/{alice.public_id}/deactivate", headers=headers)

    resp = await client.post(f"{URL}/{alice.public_id}/reactivate", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["is_active"] is True
    login = await client.post(
        LOGIN_URL, json={"email": "alice@example.com", "password": "correct-horse"}
    )
    assert login.status_code == 200
    assert await _watch_count(db_session, alice) == 0


async def test_reactivate_unknown_404(client: AsyncClient, db_session: AsyncSession) -> None:
    headers = await admin_headers(client, db_session)
    resp = await client.post(f"{URL}/{uuid.uuid4()}/reactivate", headers=headers)
    assert resp.status_code == 404


async def test_reactivate_active_409(client: AsyncClient, db_session: AsyncSession) -> None:
    headers = await admin_headers(client, db_session)
    alice = await create_user(db_session, email="alice@example.com")
    resp = await client.post(f"{URL}/{alice.public_id}/reactivate", headers=headers)
    assert resp.status_code == 409
    assert resp.json()["detail"] == "帳號已經是啟用狀態"


async def test_non_admin_forbidden(client: AsyncClient, db_session: AsyncSession) -> None:
    headers = await auth_headers(client, db_session)
    bob = await create_user(db_session, email="bob@example.com")
    for action in ("deactivate", "reactivate"):
        resp = await client.post(f"{URL}/{bob.public_id}/{action}", headers=headers)
        assert resp.status_code == 403
