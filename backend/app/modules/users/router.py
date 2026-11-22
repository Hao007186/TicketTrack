from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Response, status

from app.modules.auth import messages, passwords, service
from app.modules.auth.deps import CurrentUser, WritableUser
from app.modules.auth.router import SessionDep, SettingsDep, _token_response
from app.modules.auth.schemas import ChangePasswordRequest, TokenResponse
from app.modules.users.schemas import UserOut

router = APIRouter(tags=["users"])

SAME_PASSWORD = "新密碼不能和目前的密碼相同"


@router.get("/me")
async def me(user: CurrentUser) -> UserOut:
    return UserOut.model_validate(user)


@router.post("/me/password")
async def change_password(
    body: ChangePasswordRequest,
    response: Response,
    user: WritableUser,
    session: SessionDep,
    settings: SettingsDep,
) -> TokenResponse:
    try:
        pair = await passwords.change_password(
            session,
            settings,
            user,
            body.current_password,
            body.new_password,
            datetime.now(UTC),
        )
    except service.WrongPassword as e:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, messages.wrong_current_password(e.remaining)
        ) from None
    except service.AccountLocked as e:
        raise HTTPException(status.HTTP_423_LOCKED, messages.locked(e.minutes)) from None
    except passwords.SamePassword:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, SAME_PASSWORD) from None
    return _token_response(response, pair, settings)
