"""admin 測試共用 watches 的參考資料 fixture 與佈置 helper，另加 admin 登入。"""

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from tests.conftest import create_user
from tests.watches.conftest import (
    TODAY,
    auth_headers,
    conditions,
    demo_headers,
    fill_slots,
    fixed_today,
    insert_watch,
    reference,
)

__all__ = [
    "TODAY",
    "admin_headers",
    "auth_headers",
    "conditions",
    "demo_headers",
    "fill_slots",
    "fixed_today",
    "insert_watch",
    "reference",
]


async def admin_headers(
    client: AsyncClient, session: AsyncSession, email: str = "admin@example.com"
) -> dict[str, str]:
    await create_user(session, email=email, role="admin")
    resp = await client.post(
        "/api/v1/auth/login", json={"email": email, "password": "correct-horse"}
    )
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}
