import uuid
from datetime import date, datetime

from pydantic import BaseModel


class AdminUserOut(BaseModel):
    public_id: uuid.UUID
    email: str
    display_name: str | None
    role: str
    is_demo: bool
    is_active: bool
    created_at: datetime
    # 狀態是 active 或 queued 的追蹤數
    slot_count: int
    # 全部狀態的追蹤數；停用時會全部刪掉
    watch_count: int


class AdminWatchOut(BaseModel):
    public_id: uuid.UUID
    owner_email: str
    origin: str
    destination: str
    depart_date: date
    return_date: date | None
    status: str
    created_at: datetime


class AdminUsageOut(BaseModel):
    # 下面三個依賴即時查到的剩餘額度，查不到時是 None
    serpapi_remaining: int | None
    daily_budget: int | None
    instant_remaining: int | None
    month_calls: int
    checked_today: int
    instant_today: int
    slots_used: int
    slots_max: int
    queued: int
    email_sent: int
    email_failed: int
    email_pending: int
