from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.auth import messages, service
from app.modules.auth.service import DEMO_EMAIL
from app.modules.users.models import User
from tests.conftest import create_user

URL = "/api/v1/auth/login"
BAD_CREDENTIALS = "Email 或密碼錯誤"
LOCKED = messages.locked(service.LOCKOUT_DURATION.seconds // 60)


@pytest.fixture
async def user(db_session: AsyncSession) -> User:
    return await create_user(db_session)


async def _login(client: AsyncClient, password: str = "correct-horse") -> Response:
    return await client.post(URL, json={"email": "alice@example.com", "password": password})


async def test_login_success(client: AsyncClient, user: User) -> None:
    resp = await _login(client)
    assert resp.status_code == 200
    assert resp.json()["access_token"]
    assert "refresh_token=" in resp.headers["set-cookie"]


async def test_login_email_case_insensitive(client: AsyncClient, user: User) -> None:
    resp = await client.post(URL, json={"email": "ALICE@example.com", "password": "correct-horse"})
    assert resp.status_code == 200


async def test_wrong_password_and_unknown_email_both_401(client: AsyncClient, user: User) -> None:
    wrong = await _login(client, "wrong-horse")
    unknown = await client.post(URL, json={"email": "nobody@example.com", "password": "x" * 8})
    assert wrong.status_code == unknown.status_code == 401


async def test_wrong_password_shows_remaining(client: AsyncClient, user: User) -> None:
    resp = await _login(client, "wrong")
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Email 或密碼錯誤，再錯 4 次會鎖定 15 分鐘"


async def test_fifth_failure_locks_immediately(client: AsyncClient, user: User) -> None:
    for _ in range(4):
        assert (await _login(client, "wrong")).status_code == 401
    resp = await _login(client, "wrong")
    assert resp.status_code == 423
    assert (
        resp.json()["detail"]
        == "登入失敗次數過多，帳號已鎖定，請約 15 分鐘後再試，或使用忘記密碼重設"
    )


async def test_locked_minutes_round_up(
    client: AsyncClient, db_session: AsyncSession, user: User
) -> None:
    user.locked_until = datetime.now(UTC) + timedelta(minutes=11, seconds=5)
    await db_session.flush()
    resp = await _login(client)
    assert resp.status_code == 423
    assert "約 12 分鐘" in resp.json()["detail"]


async def test_correct_password_while_locked_still_423(client: AsyncClient, user: User) -> None:
    for _ in range(5):
        await _login(client, "wrong-horse")
    resp = await _login(client)
    assert resp.status_code == 423
    assert resp.json()["detail"] == LOCKED


async def test_unknown_email_no_count(client: AsyncClient, user: User) -> None:
    resp = await client.post(URL, json={"email": "nobody@example.com", "password": "x"})
    assert resp.status_code == 401
    assert resp.json()["detail"] == BAD_CREDENTIALS


async def test_lockout_after_five_failures(client: AsyncClient, user: User) -> None:
    for _ in range(4):
        assert (await _login(client, "wrong-horse")).status_code == 401
    assert (await _login(client, "wrong-horse")).status_code == 423
    resp = await _login(client)
    assert resp.status_code == 423
    assert resp.json()["detail"] == LOCKED


async def test_locked_attempts_do_not_count(
    client: AsyncClient, user: User, db_session: AsyncSession
) -> None:
    for _ in range(5):
        await _login(client, "wrong-horse")
    for _ in range(3):
        assert (await _login(client, "wrong-horse")).status_code == 423
    await db_session.refresh(user)
    assert user.failed_login_count == 0
    assert user.locked_until is not None


async def test_lock_expires(client: AsyncClient, user: User, db_session: AsyncSession) -> None:
    user.locked_until = datetime.now(UTC) - timedelta(minutes=1)
    await db_session.flush()
    assert (await _login(client)).status_code == 200


async def test_failures_count_again_after_lock_expires(
    client: AsyncClient, user: User, db_session: AsyncSession
) -> None:
    user.locked_until = datetime.now(UTC) - timedelta(minutes=1)
    await db_session.flush()
    assert (await _login(client, "wrong-horse")).status_code == 401
    await db_session.refresh(user)
    assert user.failed_login_count == 1


async def test_success_resets_failures(
    client: AsyncClient, user: User, db_session: AsyncSession
) -> None:
    for _ in range(3):
        await _login(client, "wrong-horse")
    assert (await _login(client)).status_code == 200
    await db_session.refresh(user)
    assert user.failed_login_count == 0
    assert user.locked_until is None


async def test_inactive_user_rejected(client: AsyncClient, db_session: AsyncSession) -> None:
    await create_user(db_session, is_active=False)
    resp = await _login(client)
    assert resp.status_code == 401
    assert resp.json()["detail"] == BAD_CREDENTIALS


async def test_inactive_user_locked_still_401(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    inactive = await create_user(db_session, is_active=False)
    inactive.locked_until = datetime.now(UTC) + timedelta(minutes=10)
    await db_session.flush()
    for password in ("correct-horse", "wrong-horse"):
        resp = await _login(client, password)
        assert resp.status_code == 401
        assert resp.json()["detail"] == BAD_CREDENTIALS


async def test_demo_user_wrong_password_no_count_shown(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    await create_user(db_session, email="demo2@example.com", password="x" * 8, is_demo=True)
    resp = await client.post(URL, json={"email": "demo2@example.com", "password": "wrong-pass"})
    assert resp.status_code == 401
    assert resp.json()["detail"] == BAD_CREDENTIALS


async def test_demo_user_cannot_password_login(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    # DEMO_EMAIL 的 .local 網域本來就過不了 EmailStr；這裡驗證 is_demo 本身也會被拒
    await create_user(db_session, email="demo2@example.com", password="x" * 8, is_demo=True)
    resp = await client.post(URL, json={"email": "demo2@example.com", "password": "x" * 8})
    assert resp.status_code == 401


async def test_demo_email_cannot_password_login(client: AsyncClient) -> None:
    resp = await client.post(URL, json={"email": DEMO_EMAIL, "password": "x" * 8})
    assert resp.status_code == 422


async def test_concurrent_failures_all_count(
    client: AsyncClient, user: User, db_session: AsyncSession
) -> None:
    # 這個請求讀到的失敗次數是 0（user fixture 已載入 session）；
    # 同時其他平行請求已經累加到 4 次
    await db_session.execute(
        text("UPDATE users SET failed_login_count = 4 WHERE id = :id"), {"id": user.id}
    )
    # 第 5 次失敗必須以 DB 的最新值累加，當場觸發鎖定
    assert (await _login(client, "wrong-horse")).status_code == 423
    assert (await _login(client)).status_code == 423
