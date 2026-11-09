"""後台：列出帳號與追蹤、停用與恢復帳號、刪除任何人的追蹤。"""

import uuid
from datetime import date

from sqlalchemy import Select, and_, delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.admin.schemas import AdminUserOut, AdminWatchOut
from app.modules.auth.models import RefreshToken
from app.modules.users.models import User
from app.modules.watches import slots
from app.modules.watches.models import PriceQuery, Watch
from app.modules.watches.service import WatchNotFound, remove_watch

SLOT_STATUSES = ("active", "queued")


class UserNotFound(Exception):
    pass


class CannotDeactivate(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class CannotDeleteDemoWatch(Exception):
    pass


class AlreadyInState(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def _users_with_slots() -> Select[User, int]:
    slot_count = func.count(Watch.id).label("slot_count")
    return (
        select(User, slot_count)
        .outerjoin(Watch, and_(Watch.user_id == User.id, Watch.status.in_(SLOT_STATUSES)))
        .group_by(User.id)
    )


def _to_out(user: User, slot_count: int) -> AdminUserOut:
    return AdminUserOut(
        public_id=user.public_id,
        email=user.email,
        display_name=user.display_name,
        role=user.role,
        is_demo=user.is_demo,
        is_active=user.is_active,
        created_at=user.created_at,
        slot_count=slot_count,
    )


async def list_users(session: AsyncSession) -> list[AdminUserOut]:
    rows = await session.execute(
        _users_with_slots()
        .order_by(User.created_at.desc(), User.id.desc())
        .execution_options(populate_existing=True)
    )
    return [_to_out(user, count) for user, count in rows]


async def _get_user_out(session: AsyncSession, public_id: uuid.UUID) -> AdminUserOut:
    row = (
        await session.execute(
            _users_with_slots()
            .where(User.public_id == public_id)
            .execution_options(populate_existing=True)
        )
    ).one_or_none()
    if row is None:
        raise UserNotFound
    user, count = row
    return _to_out(user, count)


async def _find_user(session: AsyncSession, public_id: uuid.UUID) -> User:
    user = await session.scalar(
        select(User).where(User.public_id == public_id).execution_options(populate_existing=True)
    )
    if user is None:
        raise UserNotFound
    return user


async def deactivate_user(
    session: AsyncSession, admin: User, public_id: uuid.UUID, today: date
) -> AdminUserOut:
    """停用帳號並刪掉他所有的追蹤與登入 token，空出的名額補位給排隊的人。"""
    await slots.acquire_watch_lock(session)
    user = await _find_user(session, public_id)
    if user.id == admin.id:
        raise CannotDeactivate("不能停用自己的帳號")
    if user.is_demo:
        raise CannotDeactivate("不能停用示範帳號")
    if user.role == "admin":
        raise CannotDeactivate("不能停用管理員帳號")
    if not user.is_active:
        raise AlreadyInState("帳號已經是停用狀態")

    user.is_active = False
    await session.execute(delete(Watch).where(Watch.user_id == user.id))
    await session.execute(delete(RefreshToken).where(RefreshToken.user_id == user.id))
    await session.flush()
    await slots.rebalance(session, today)
    await session.commit()
    return await _get_user_out(session, public_id)


async def reactivate_user(session: AsyncSession, public_id: uuid.UUID) -> AdminUserOut:
    user = await _find_user(session, public_id)
    if user.is_active:
        raise AlreadyInState("帳號已經是啟用狀態")
    user.is_active = True
    await session.commit()
    return await _get_user_out(session, public_id)


async def list_watches(session: AsyncSession) -> list[AdminWatchOut]:
    """佔名額或排隊中的追蹤（不含示範資料），依補位順序由舊到新。"""
    rows = await session.execute(
        select(Watch, User.email, PriceQuery)
        .join(User, Watch.user_id == User.id)
        .join(PriceQuery, Watch.price_query_id == PriceQuery.id)
        .where(Watch.status.in_(SLOT_STATUSES), PriceQuery.is_demo.is_(False))
        .order_by(Watch.created_at, Watch.id)
        .execution_options(populate_existing=True)
    )
    return [
        AdminWatchOut(
            public_id=watch.public_id,
            owner_email=email,
            origin=query.origin,
            destination=query.destination,
            depart_date=query.depart_date,
            return_date=query.return_date,
            status=watch.status,
            created_at=watch.created_at,
        )
        for watch, email, query in rows
    ]


async def delete_any_watch(session: AsyncSession, public_id: uuid.UUID, today: date) -> None:
    await slots.acquire_watch_lock(session)
    row = (
        await session.execute(
            select(Watch, PriceQuery.is_demo)
            .join(PriceQuery, Watch.price_query_id == PriceQuery.id)
            .where(Watch.public_id == public_id)
        )
    ).one_or_none()
    if row is None:
        raise WatchNotFound
    watch, is_demo = row
    if is_demo:
        raise CannotDeleteDemoWatch
    await remove_watch(session, watch, today)
