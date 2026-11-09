"""後台：列出帳號與追蹤、停用與恢復帳號、刪除任何人的追蹤。"""

from sqlalchemy import Select, and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.admin.schemas import AdminUserOut
from app.modules.users.models import User
from app.modules.watches.models import Watch

SLOT_STATUSES = ("active", "queued")


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
