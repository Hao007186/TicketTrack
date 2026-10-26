"""每日維護：出發日已過的追蹤標成過期並補位。python -m app.jobs.maintenance"""

import asyncio
import sys

import app.db.models  # noqa: F401  獨立執行時也要註冊所有表
from app.core.clock import taipei_today
from app.db.session import get_sessionmaker
from app.modules.watches.service import expire_watches


async def run_maintenance() -> tuple[int, int]:
    """回傳（過期數, 啟用數）。命令列和 Lambda 共用。"""
    async with get_sessionmaker()() as session:
        expired, activated = await expire_watches(session, taipei_today())
    print(f"每日維護完成：過期 {expired} 個、啟用 {activated} 個")
    return expired, activated


if __name__ == "__main__":
    # psycopg async 不支援 Windows 預設的 ProactorEventLoop
    loop_factory = asyncio.SelectorEventLoop if sys.platform == "win32" else None
    asyncio.run(run_maintenance(), loop_factory=loop_factory)
