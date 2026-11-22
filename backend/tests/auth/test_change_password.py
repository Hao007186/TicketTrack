from httpx import AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.auth import messages, service
from tests.auth.conftest import cookie_token, refresh_with
from tests.conftest import create_user

URL = "/api/v1/me/password"
LOGIN = "/api/v1/auth/login"
OLD = "correct-horse"
NEW = "new-password-1"
WRONG_CURRENT = messages.wrong_current_password
LOCKED = messages.locked(service.LOCKOUT_DURATION.seconds // 60)
SAME = "新密碼不能和目前的密碼相同"


async def _login(
    client: AsyncClient, password: str = OLD, email: str = "alice@example.com"
) -> Response:
    return await client.post(LOGIN, json={"email": email, "password": password})


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def test_change_password_success(client: AsyncClient, db_session: AsyncSession) -> None:
    await create_user(db_session)
    first = await _login(client)
    second = await _login(client)
    first_access = first.json()["access_token"]
    second_refresh = cookie_token(second)

    resp = await client.post(
        URL, json={"current_password": OLD, "new_password": NEW}, headers=_auth(first_access)
    )

    assert resp.status_code == 200
    assert resp.json()["access_token"]
    new_refresh = cookie_token(resp)
    assert "path=/api/v1/auth" in resp.headers["set-cookie"].lower()

    # 其他裝置被登出，這次回應給的新 refresh cookie 可用
    # （先試新的：舊 token 被重用會觸發連坐作廢）
    assert (await refresh_with(client, new_refresh)).status_code == 200
    assert (await refresh_with(client, second_refresh)).status_code == 401

    assert (await _login(client, OLD)).status_code == 401
    assert (await _login(client, NEW)).status_code == 200


async def test_wrong_current_password_counts(client: AsyncClient, db_session: AsyncSession) -> None:
    await create_user(db_session)
    token = (await _login(client)).json()["access_token"]

    resp = await client.post(
        URL, json={"current_password": "wrong", "new_password": NEW}, headers=_auth(token)
    )

    assert resp.status_code == 400
    assert resp.json()["detail"] == "目前的密碼錯誤，再錯 4 次會鎖定 15 分鐘"


async def test_fifth_wrong_current_password_locks(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    await create_user(db_session)
    token = (await _login(client)).json()["access_token"]
    body = {"current_password": "wrong", "new_password": NEW}

    for _ in range(service.MAX_FAILED_LOGINS - 1):
        resp = await client.post(URL, json=body, headers=_auth(token))
        assert resp.status_code == 400
    resp = await client.post(URL, json=body, headers=_auth(token))

    assert resp.status_code == 423
    assert resp.json()["detail"] == LOCKED
    assert (await _login(client, OLD)).status_code == 423


async def test_same_password_rejected(client: AsyncClient, db_session: AsyncSession) -> None:
    await create_user(db_session)
    token = (await _login(client)).json()["access_token"]

    resp = await client.post(
        URL, json={"current_password": OLD, "new_password": OLD}, headers=_auth(token)
    )

    assert resp.status_code == 400
    assert resp.json()["detail"] == SAME
    # 沒改成功，舊 refresh 與舊密碼仍有效
    assert (await _login(client, OLD)).status_code == 200


async def test_demo_forbidden(client: AsyncClient, db_session: AsyncSession) -> None:
    await create_user(db_session, email="demo@farewatch.local", is_demo=True)
    token = (await client.post("/api/v1/auth/demo")).json()["access_token"]

    resp = await client.post(
        URL, json={"current_password": OLD, "new_password": NEW}, headers=_auth(token)
    )

    assert resp.status_code == 403


async def test_requires_login(client: AsyncClient) -> None:
    resp = await client.post(URL, json={"current_password": OLD, "new_password": NEW})
    assert resp.status_code == 401


async def test_new_password_too_short(client: AsyncClient, db_session: AsyncSession) -> None:
    await create_user(db_session)
    token = (await _login(client)).json()["access_token"]

    resp = await client.post(
        URL, json={"current_password": OLD, "new_password": "short"}, headers=_auth(token)
    )

    assert resp.status_code == 422
