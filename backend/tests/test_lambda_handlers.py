import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

import app.lambda_handlers as handlers
from app.lambda_handlers import JobFailed, api_handler, jobs_handler
from app.modules.notifications.notifier import SendSummary
from tests.conftest import BACKEND_DIR


class _Context:
    function_name = "farewatch-test"
    aws_request_id = "req-1"

    def get_remaining_time_in_millis(self) -> int:
        return 30_000


def _url_event(path: str) -> dict[str, Any]:
    """Lambda Function URL（payload 2.0）格式的 GET 事件。"""
    return {
        "version": "2.0",
        "routeKey": "$default",
        "rawPath": path,
        "rawQueryString": "",
        "headers": {"host": "abc.lambda-url.ap-southeast-1.on.aws"},
        "requestContext": {
            "accountId": "anonymous",
            "apiId": "abc",
            "domainName": "abc.lambda-url.ap-southeast-1.on.aws",
            "domainPrefix": "abc",
            "http": {
                "method": "GET",
                "path": path,
                "protocol": "HTTP/1.1",
                "sourceIp": "1.2.3.4",
                "userAgent": "test",
            },
            "requestId": "req-1",
            "routeKey": "$default",
            "stage": "$default",
            "time": "26/Oct/2026:00:00:00 +0000",
            "timeEpoch": 1792972800000,
        },
        "isBase64Encoded": False,
    }


def test_api_handler_health() -> None:
    resp = api_handler(_url_event("/api/v1/health"), _Context())  # type: ignore[arg-type]
    assert resp["statusCode"] == 200
    assert json.loads(resp["body"]) == {"status": "ok"}


def _fake(result: Any) -> Any:
    async def run() -> Any:
        return result

    return run


def test_jobs_check_prices(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(handlers, "run_check_prices", _fake(0))
    assert jobs_handler({"job": "check_prices"}, _Context()) == {
        "job": "check_prices",
        "exit_code": 0,
    }


def test_jobs_check_prices_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(handlers, "run_check_prices", _fake(1))
    with pytest.raises(JobFailed):
        jobs_handler({"job": "check_prices"}, _Context())


def test_jobs_send_notifications(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(handlers, "run_send_notifications", _fake(SendSummary(sent=2)))
    assert jobs_handler({"job": "send_notifications"}, _Context()) == {
        "job": "send_notifications",
        "sent": 2,
        "failed": 0,
        "skipped": 0,
        "retry": 0,
    }


def test_jobs_maintenance(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(handlers, "run_maintenance", _fake((3, 1)))
    assert jobs_handler({"job": "maintenance"}, _Context()) == {
        "job": "maintenance",
        "expired": 3,
        "activated": 1,
    }


@pytest.mark.parametrize("event", [{"job": "nope"}, {}])
def test_jobs_unknown(event: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        jobs_handler(event, _Context())


def test_jobs_twice_in_same_process(monkeypatch: pytest.MonkeyPatch) -> None:
    # 暖機的 Lambda 會在同一個行程連續執行；每次都要用新的 event loop
    monkeypatch.setattr(handlers, "run_maintenance", _fake((0, 0)))
    for _ in range(2):
        assert jobs_handler({"job": "maintenance"}, _Context())["expired"] == 0


_COLD_START = """
import sys, types

class FakeSSM:
    def get_parameters_by_path(self, **kwargs):
        return {"Parameters": [{"Name": "/x/jwt_secret", "Value": "from-ssm"}]}

fake = types.ModuleType("boto3")
fake.client = lambda name: FakeSSM()
sys.modules["boto3"] = fake

import app.lambda_handlers
from app.core.config import get_settings
assert get_settings().jwt_secret == "from-ssm"
"""


def _cold_start(tmp_path: Path, ssm_path: str | None) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env.pop("JWT_SECRET", None)
    env.pop("SSM_PARAMETER_PATH", None)
    if ssm_path:
        env["SSM_PARAMETER_PATH"] = ssm_path
    env["PYTHONPATH"] = str(BACKEND_DIR)
    # cwd 換到空目錄，避免讀到 backend/.env 裡的 JWT_SECRET
    return subprocess.run(
        [sys.executable, "-c", _COLD_START],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def test_cold_start_loads_ssm_before_app(tmp_path: Path) -> None:
    result = _cold_start(tmp_path, "/x/")
    assert result.returncode == 0, result.stderr


def test_cold_start_without_ssm_fails(tmp_path: Path) -> None:
    # 對照組：沒有 SSM 就缺 JWT_SECRET，證明上一個測試真的靠 SSM 才成功
    result = _cold_start(tmp_path, None)
    assert result.returncode != 0
    assert "jwt_secret" in result.stderr.lower()
