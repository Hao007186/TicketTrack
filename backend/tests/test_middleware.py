from collections.abc import AsyncIterator, Iterator

import pytest
from fastapi import FastAPI, Request
from httpx import ASGITransport, AsyncClient
from starlette.types import ASGIApp

from app.core.config import get_settings
from app.core.middleware import BodySizeLimitMiddleware, OriginVerifyMiddleware
from app.main import create_app


def _inner() -> FastAPI:
    app = FastAPI()

    @app.get("/ping")
    async def ping() -> dict[str, bool]:
        return {"ok": True}

    @app.post("/echo")
    async def echo(request: Request) -> dict[str, int]:
        return {"length": len(await request.body())}

    return app


def _client(app: ASGIApp) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="https://test")


async def _chunks(*parts: bytes) -> AsyncIterator[bytes]:
    for part in parts:
        yield part


# --- OriginVerify ---


async def test_origin_missing_header_403() -> None:
    async with _client(OriginVerifyMiddleware(_inner(), "s3cret")) as c:
        resp = await c.get("/ping")
    assert resp.status_code == 403
    assert resp.json() == {"detail": "Forbidden"}


async def test_origin_wrong_header_403() -> None:
    async with _client(OriginVerifyMiddleware(_inner(), "s3cret")) as c:
        resp = await c.get("/ping", headers={"x-origin-verify": "nope"})
    assert resp.status_code == 403


async def test_origin_right_header_passes() -> None:
    async with _client(OriginVerifyMiddleware(_inner(), "s3cret")) as c:
        resp = await c.get("/ping", headers={"x-origin-verify": "s3cret"})
    assert resp.status_code == 200


async def test_origin_disabled_when_no_secret() -> None:
    async with _client(OriginVerifyMiddleware(_inner(), None)) as c:
        resp = await c.get("/ping")
    assert resp.status_code == 200


# --- BodySizeLimit ---


async def test_body_content_length_over_limit_413() -> None:
    async with _client(BodySizeLimitMiddleware(_inner(), max_bytes=10)) as c:
        resp = await c.post("/echo", content=b"x" * 11)
    assert resp.status_code == 413
    assert resp.json() == {"detail": "請求內容太大"}


async def test_body_at_limit_passes() -> None:
    async with _client(BodySizeLimitMiddleware(_inner(), max_bytes=10)) as c:
        resp = await c.post("/echo", content=b"x" * 10)
    assert resp.status_code == 200
    assert resp.json() == {"length": 10}


async def test_chunked_body_over_limit_413() -> None:
    async with _client(BodySizeLimitMiddleware(_inner(), max_bytes=10)) as c:
        resp = await c.post("/echo", content=_chunks(b"x" * 6, b"x" * 6))
    assert resp.status_code == 413
    assert resp.json() == {"detail": "請求內容太大"}


async def test_chunked_body_under_limit_passes() -> None:
    async with _client(BodySizeLimitMiddleware(_inner(), max_bytes=10)) as c:
        resp = await c.post("/echo", content=_chunks(b"x" * 4, b"x" * 4))
    assert resp.status_code == 200
    assert resp.json() == {"length": 8}


# --- 掛在真正的 app 上 ---


async def test_app_rejects_large_body(client: AsyncClient) -> None:
    resp = await client.post(
        "/api/v1/auth/login",
        content=b"{" + b" " * 70_000 + b"}",
        headers={"content-type": "application/json"},
    )
    assert resp.status_code == 413


@pytest.fixture
def origin_secret(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("ORIGIN_VERIFY_SECRET", "s3cret")
    get_settings.cache_clear()
    yield
    monkeypatch.delenv("ORIGIN_VERIFY_SECRET")
    get_settings.cache_clear()


@pytest.mark.usefixtures("origin_secret")
async def test_app_origin_check_covers_health() -> None:
    async with _client(create_app()) as c:
        assert (await c.get("/api/v1/health")).status_code == 403
        ok = await c.get("/api/v1/health", headers={"x-origin-verify": "s3cret"})
        assert ok.status_code == 200
