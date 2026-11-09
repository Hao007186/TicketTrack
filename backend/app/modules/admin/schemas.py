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


class AdminWatchOut(BaseModel):
    public_id: uuid.UUID
    owner_email: str
    origin: str
    destination: str
    depart_date: date
    return_date: date | None
    status: str
    created_at: datetime
