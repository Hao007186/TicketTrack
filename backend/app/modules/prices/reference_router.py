"""目標價參考價：用資料庫已有的典型價格區間，不花查價額度。"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session
from app.modules.auth.deps import CurrentUser
from app.modules.prices.models import PriceBaseline
from app.modules.prices.schemas import PriceReferenceOut
from app.modules.watches.models import PriceQuery
from app.modules.watches.schemas import QueryConditionsIn
from app.modules.watches.slots import QueryConditions

router = APIRouter(tags=["prices"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]
_EMPTY = PriceReferenceOut(typical_low=None, typical_high=None, updated_at=None)


@router.get("/price-reference")
async def get_price_reference(
    cond: Annotated[QueryConditionsIn, Query()], user: CurrentUser, session: SessionDep
) -> PriceReferenceOut:
    # 只比對完全相同的條件；is_demo 跟著登入的帳號，示範資料和一般資料互相查不到
    query_hash = QueryConditions(
        origin=cond.origin,
        destination=cond.destination,
        depart_date=cond.depart_date,
        return_date=cond.return_date,
        cabin=cond.cabin,
        adults=cond.adults,
        airlines=tuple(cond.airlines),
        is_demo=user.is_demo,
    ).query_hash()
    query_id = await session.scalar(
        select(PriceQuery.id).where(PriceQuery.query_hash == query_hash)
    )
    if query_id is None:
        return _EMPTY
    baseline = await session.get(PriceBaseline, query_id)
    if baseline is None or baseline.typical_low is None:
        return _EMPTY
    return PriceReferenceOut(
        typical_low=baseline.typical_low,
        typical_high=baseline.typical_high,
        updated_at=baseline.updated_at,
    )
