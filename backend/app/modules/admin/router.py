from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session
from app.modules.admin import service
from app.modules.admin.schemas import AdminUserOut
from app.modules.auth.deps import AdminUser

router = APIRouter(tags=["admin"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]


@router.get("/users")
async def list_users(_: AdminUser, session: SessionDep) -> list[AdminUserOut]:
    return await service.list_users(session)
