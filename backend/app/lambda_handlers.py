"""Lambda 的兩個入口；同一份 image，用 image_config.command 選 handler。

- api_handler：Function URL 的 HTTP 請求，經 Mangum 交給 FastAPI
- jobs_handler：EventBridge Scheduler 的排程，事件內容 {"job": "..."} 決定要做什麼
"""

import asyncio
from dataclasses import asdict
from typing import Any

from app.core.secrets import load_ssm_parameters

# 必須在 import app.main 之前：app.main 載入時就會建立 app 並讀取 Settings，
# 機密要先從 SSM 寫進環境變數
load_ssm_parameters()

from mangum import Mangum  # noqa: E402

from app.jobs.check_prices import run_check_prices  # noqa: E402
from app.jobs.maintenance import run_maintenance  # noqa: E402
from app.jobs.send_notifications import run_send_notifications  # noqa: E402
from app.main import app  # noqa: E402


class JobFailed(Exception):
    """讓 Lambda 把這次執行記為失敗，CloudWatch 告警才抓得到。"""


api_handler = Mangum(app, lifespan="off")


def jobs_handler(event: dict[str, Any], context: object) -> dict[str, Any]:
    job = event.get("job")
    # 每次用新的 asyncio.run；暖機的 Lambda 會在同一個行程連續執行
    if job == "check_prices":
        exit_code = asyncio.run(run_check_prices())
        if exit_code != 0:
            raise JobFailed(f"查價失敗，exit code {exit_code}")
        return {"job": job, "exit_code": exit_code}
    if job == "send_notifications":
        summary = asyncio.run(run_send_notifications())
        return {"job": job, **asdict(summary)}
    if job == "maintenance":
        expired, activated = asyncio.run(run_maintenance())
        return {"job": job, "expired": expired, "activated": activated}
    raise ValueError(f"不認得的工作：{job!r}")
