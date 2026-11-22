from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.db.session import get_session
from app.modules.auth import messages, passwords, service
from app.modules.auth.schemas import (
    LoginRequest,
    MessageResponse,
    PasswordResetConfirm,
    PasswordResetRequest,
    RegisterRequest,
    TokenResponse,
)
from app.modules.notifications.deps import SenderDep

REFRESH_COOKIE = "refresh_token"
# 只有呼叫 auth 端點時瀏覽器才會送出 refresh cookie
REFRESH_COOKIE_PATH = "/api/v1/auth"

router = APIRouter(tags=["auth"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]
SettingsDep = Annotated[Settings, Depends(get_settings)]


def set_refresh_cookie(response: Response, token: str, settings: Settings) -> None:
    response.set_cookie(
        REFRESH_COOKIE,
        token,
        max_age=settings.refresh_token_days * 24 * 60 * 60,
        path=REFRESH_COOKIE_PATH,
        secure=settings.cookie_secure,
        httponly=True,
        samesite="strict",
    )


def clear_refresh_cookie(response: Response, settings: Settings) -> None:
    # 屬性要和設定時相同，瀏覽器才會刪掉同一個 cookie
    response.delete_cookie(
        REFRESH_COOKIE,
        path=REFRESH_COOKIE_PATH,
        secure=settings.cookie_secure,
        httponly=True,
        samesite="strict",
    )


def _token_response(
    response: Response, pair: service.TokenPair, settings: Settings
) -> TokenResponse:
    set_refresh_cookie(response, pair.refresh_token, settings)
    return TokenResponse(access_token=pair.access_token)


@router.post("/register", status_code=status.HTTP_201_CREATED)
async def register(
    body: RegisterRequest, response: Response, session: SessionDep, settings: SettingsDep
) -> TokenResponse:
    try:
        pair = await service.register(
            session,
            settings,
            email=body.email,
            password=body.password,
            display_name=body.display_name,
        )
    except service.EmailAlreadyRegistered:
        raise HTTPException(status.HTTP_409_CONFLICT, "此 Email 已註冊") from None
    return _token_response(response, pair, settings)


@router.post("/login")
async def login(
    body: LoginRequest, response: Response, session: SessionDep, settings: SettingsDep
) -> TokenResponse:
    try:
        pair = await service.login(
            session, settings, email=body.email, password=body.password, now=datetime.now(UTC)
        )
    except service.InvalidCredentials:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, messages.BAD_CREDENTIALS) from None
    except service.WrongPassword as e:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, messages.wrong_password(e.remaining)
        ) from None
    except service.AccountLocked as e:
        raise HTTPException(status.HTTP_423_LOCKED, messages.locked(e.minutes)) from None
    return _token_response(response, pair, settings)


RefreshCookie = Annotated[str | None, Cookie(alias=REFRESH_COOKIE)]


@router.post("/refresh", response_model=TokenResponse)
async def refresh(
    response: Response,
    session: SessionDep,
    settings: SettingsDep,
    refresh_token: RefreshCookie = None,
) -> TokenResponse | JSONResponse:
    try:
        if refresh_token is None:
            raise service.InvalidRefreshToken
        pair = await service.refresh(session, settings, refresh_token=refresh_token)
    except service.InvalidRefreshToken:
        # 用 HTTPException 的話，對 response 做的 cookie 刪除不會帶出去
        rejected = JSONResponse({"detail": "請重新登入"}, status_code=status.HTTP_401_UNAUTHORIZED)
        clear_refresh_cookie(rejected, settings)
        return rejected
    return _token_response(response, pair, settings)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    session: SessionDep, settings: SettingsDep, refresh_token: RefreshCookie = None
) -> Response:
    await service.logout(session, refresh_token=refresh_token)
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    clear_refresh_cookie(response, settings)
    return response


@router.post("/demo")
async def demo(response: Response, session: SessionDep, settings: SettingsDep) -> TokenResponse:
    try:
        pair = await service.demo_login(session, settings)
    except service.DemoUserMissing:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "示範帳號尚未建立") from None
    return _token_response(response, pair, settings)


RESET_REQUEST_ACK = "如果這個 Email 有註冊，重設信已寄出，請在 30 分鐘內點信裡的連結"
RESET_INVALID = "重設連結已失效或已使用，請重新申請"


@router.post("/password-reset/request", status_code=status.HTTP_202_ACCEPTED)
async def password_reset_request(
    body: PasswordResetRequest, session: SessionDep, settings: SettingsDep, sender: SenderDep
) -> MessageResponse:
    await passwords.request_reset(
        session, sender, settings.app_base_url, body.email, datetime.now(UTC)
    )
    return MessageResponse(detail=RESET_REQUEST_ACK)


@router.post("/password-reset/confirm", status_code=status.HTTP_204_NO_CONTENT)
async def password_reset_confirm(body: PasswordResetConfirm, session: SessionDep) -> Response:
    try:
        await passwords.confirm_reset(session, body.token, body.new_password, datetime.now(UTC))
    except passwords.InvalidResetToken:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, RESET_INVALID) from None
    return Response(status_code=status.HTTP_204_NO_CONTENT)
