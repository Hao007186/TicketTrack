import uuid
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import get_today
from app.db.session import get_session
from app.modules.admin import service
from app.modules.admin.schemas import AdminUsageOut, AdminUserOut, AdminWatchOut
from app.modules.admin.usage import get_usage
from app.modules.auth.deps import AdminUser
from app.modules.prices.deps import ProviderDep
from app.modules.watches.service import WatchNotFound

router = APIRouter(tags=["admin"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]
TodayDep = Annotated[date, Depends(get_today)]


def _http_error(e: Exception) -> HTTPException:
    match e:
        case service.UserNotFound():
            return HTTPException(status.HTTP_404_NOT_FOUND, "找不到帳號")
        case service.CannotDeactivate(message=message) | service.AlreadyInState(message=message):
            return HTTPException(status.HTTP_409_CONFLICT, message)
        case WatchNotFound():
            return HTTPException(status.HTTP_404_NOT_FOUND, "找不到追蹤")
        case service.CannotDeleteDemoWatch():
            return HTTPException(status.HTTP_409_CONFLICT, "不能刪除示範帳號的追蹤")
    raise e


_ERRORS = (
    service.UserNotFound,
    service.CannotDeactivate,
    service.AlreadyInState,
    WatchNotFound,
    service.CannotDeleteDemoWatch,
)


@router.get("/users")
async def list_users(_: AdminUser, session: SessionDep) -> list[AdminUserOut]:
    return await service.list_users(session)


@router.post("/users/{public_id}/deactivate")
async def deactivate_user(
    public_id: uuid.UUID, admin: AdminUser, session: SessionDep, today: TodayDep
) -> AdminUserOut:
    try:
        return await service.deactivate_user(session, admin, public_id, today)
    except _ERRORS as e:
        raise _http_error(e) from None


@router.post("/users/{public_id}/reactivate")
async def reactivate_user(public_id: uuid.UUID, _: AdminUser, session: SessionDep) -> AdminUserOut:
    try:
        return await service.reactivate_user(session, public_id)
    except _ERRORS as e:
        raise _http_error(e) from None


@router.get("/watches")
async def list_watches(_: AdminUser, session: SessionDep) -> list[AdminWatchOut]:
    return await service.list_watches(session)


@router.delete("/watches/{public_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_watch(
    public_id: uuid.UUID, _: AdminUser, session: SessionDep, today: TodayDep
) -> Response:
    try:
        await service.delete_any_watch(session, public_id, today)
    except _ERRORS as e:
        raise _http_error(e) from None
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/usage")
async def usage(
    _: AdminUser, session: SessionDep, provider: ProviderDep, today: TodayDep
) -> AdminUsageOut:
    return await get_usage(session, provider, today)
