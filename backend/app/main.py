from fastapi import FastAPI

from app.api import health
from app.core.config import get_settings
from app.core.middleware import BodySizeLimitMiddleware, OriginVerifyMiddleware
from app.modules.auth import router as auth_router
from app.modules.notifications import router as notifications_router
from app.modules.prices import reference_router as price_reference_router
from app.modules.prices import router as prices_router
from app.modules.reference import router as reference_router
from app.modules.users import router as users_router
from app.modules.watches import router as watches_router

API_PREFIX = "/api/v1"


def create_app() -> FastAPI:
    app = FastAPI(title="FareWatch API")
    app.include_router(health.router, prefix=API_PREFIX)
    app.include_router(auth_router.router, prefix=f"{API_PREFIX}/auth")
    app.include_router(users_router.router, prefix=API_PREFIX)
    app.include_router(reference_router.router, prefix=API_PREFIX)
    app.include_router(watches_router.router, prefix=API_PREFIX)
    app.include_router(prices_router.router, prefix=API_PREFIX)
    app.include_router(price_reference_router.router, prefix=API_PREFIX)
    app.include_router(notifications_router.router, prefix=API_PREFIX)

    # 後加的在外層：先檢查來源，再檢查大小（外來的請求不必讀 body）
    secret = get_settings().origin_verify_secret
    app.add_middleware(BodySizeLimitMiddleware)
    app.add_middleware(OriginVerifyMiddleware, secret=secret.get_secret_value() if secret else None)
    return app


app = create_app()
