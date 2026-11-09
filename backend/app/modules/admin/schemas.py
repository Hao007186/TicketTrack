import uuid
from datetime import datetime

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
