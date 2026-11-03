"""目標價參考價：GET 用資料庫已有的典型價格區間，不花額度；POST /check 由使用者按鈕觸發查價。"""

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import get_today
from app.db.session import get_session
from app.modules.auth.deps import CurrentUser, WritableUser
from app.modules.prices.checker import today_start
from app.modules.prices.deps import ProviderDep, SenderDep, SettingsDep
from app.modules.prices.instant import check_query
from app.modules.prices.models import PriceBaseline, PriceSnapshot
from app.modules.prices.schemas import PriceCheckOut, PriceReferenceOut
from app.modules.users.models import User
from app.modules.watches import service as watch_service
from app.modules.watches import slots
from app.modules.watches.models import PriceQuery
from app.modules.watches.schemas import QueryConditionsIn
from app.modules.watches.slots import QueryConditions

router = APIRouter(tags=["prices"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]
TodayDep = Annotated[date, Depends(get_today)]
_EMPTY = PriceReferenceOut(typical_low=None, typical_high=None, updated_at=None)


def _conditions(cond: QueryConditionsIn, user: User) -> QueryConditions:
    # is_demo 跟著登入的帳號，示範資料和一般資料互相查不到
    return QueryConditions(
        origin=cond.origin,
        destination=cond.destination,
        depart_date=cond.depart_date,
        return_date=cond.return_date,
        cabin=cond.cabin,
        adults=cond.adults,
        airlines=tuple(cond.airlines),
        is_demo=user.is_demo,
    )


@router.get("/price-reference")
async def get_price_reference(
    cond: Annotated[QueryConditionsIn, Query()], user: CurrentUser, session: SessionDep
) -> PriceReferenceOut:
    # 只比對完全相同的條件
    query_hash = _conditions(cond, user).query_hash()
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


@router.post("/price-reference/check")
async def check_price_reference(
    body: QueryConditionsIn,
    user: WritableUser,
    session: SessionDep,
    provider: ProviderDep,
    sender: SenderDep,
    settings: SettingsDep,
    today: TodayDep,
) -> PriceCheckOut:
    cond = _conditions(body, user)
    try:
        await watch_service.validate_conditions(session, cond, today)
    except watch_service.InvalidWatchInput as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, e.message) from None
    # 先 commit 放掉全站鎖，查價可能要等好幾秒。沒有追蹤的 query 不會被排程查價，也不佔名額
    await slots.acquire_watch_lock(session)
    query = await slots.get_or_create_price_query(session, cond)
    query_id = query.id
    user_id = user.id
    await session.commit()

    result = await check_query(
        session, provider, sender, settings.app_base_url, user_id, query, today
    )
    if result not in ("checked", "no_result", "already_checked"):
        return PriceCheckOut(result=result, lowest_price=None, typical_low=None, typical_high=None)

    lowest_price = await session.scalar(
        select(PriceSnapshot.price)
        .where(
            PriceSnapshot.price_query_id == query_id,
            PriceSnapshot.observed_at >= today_start(today),
        )
        .order_by(PriceSnapshot.observed_at.desc(), PriceSnapshot.id.desc())
        .limit(1)
    )
    baseline = await session.get(PriceBaseline, query_id, populate_existing=True)
    return PriceCheckOut(
        result=result,
        lowest_price=lowest_price,
        typical_low=baseline.typical_low if baseline else None,
        typical_high=baseline.typical_high if baseline else None,
    )
