"""正式環境的兩道請求檢查；用純 ASGI middleware，不讀多餘的 body。"""

import hmac

from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

MAX_BODY_BYTES = 65_536


class OriginVerifyMiddleware:
    """Lambda Function URL 是公開的；只接受 CloudFront 轉送時帶上密碼標頭的請求。"""

    def __init__(self, app: ASGIApp, secret: str | None) -> None:
        self.app = app
        self.secret = secret

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or self.secret is None:
            await self.app(scope, receive, send)
            return
        given = Headers(scope=scope).get("x-origin-verify", "")
        if not hmac.compare_digest(given.encode(), self.secret.encode()):
            await JSONResponse({"detail": "Forbidden"}, status_code=403)(scope, receive, send)
            return
        await self.app(scope, receive, send)


def _too_large() -> JSONResponse:
    return JSONResponse({"detail": "請求內容太大"}, status_code=413)


class BodySizeLimitMiddleware:
    """請求內容超過上限回 413；沒有 Content-Length（chunked）時邊收邊算。"""

    def __init__(self, app: ASGIApp, max_bytes: int = MAX_BODY_BYTES) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        length = Headers(scope=scope).get("content-length")
        if length is not None and length.isdigit() and int(length) > self.max_bytes:
            await _too_large()(scope, receive, send)
            return

        if length is not None:
            await self.app(scope, receive, send)
            return

        # 沒有 Content-Length：先讀完（最多讀到上限多一點就停），再原樣交給 app。
        # 不能邊讀邊丟例外，app 的錯誤處理會把它變成 500
        body = bytearray()
        more_body = True
        while more_body:
            message = await receive()
            if message["type"] != "http.request":
                break
            body += message.get("body", b"")
            if len(body) > self.max_bytes:
                await _too_large()(scope, receive, send)
                return
            more_body = message.get("more_body", False)

        replayed = False

        async def replay() -> Message:
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        await self.app(scope, replay, send)
