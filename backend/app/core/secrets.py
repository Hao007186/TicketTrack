"""Lambda 冷啟動時把 SSM Parameter Store 的機密寫進環境變數。

必須在建立 Settings 之前呼叫，所以這裡不能 import app.core.config。
"""

import os
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from mypy_boto3_ssm import SSMClient


def load_ssm_parameters(client: SSMClient | None = None) -> int:
    """讀 SSM_PARAMETER_PATH 底下的所有參數；沒設這個環境變數時什麼都不做（本機、CI）。

    參數名稱的最後一段轉大寫當環境變數名稱，例如 /farewatch/prod/jwt_secret → JWT_SECRET。
    已經存在的環境變數不覆蓋，方便用 Lambda 環境變數臨時蓋掉某個值。
    讀取失敗直接丟出例外，寧可啟動失敗也不要帶著缺漏的設定執行。
    """
    path = os.environ.get("SSM_PARAMETER_PATH")
    if not path:
        return 0
    if client is None:
        import boto3

        client = boto3.client("ssm")

    count = 0
    kwargs: dict[str, Any] = {"Path": path, "WithDecryption": True, "Recursive": False}
    while True:
        page = client.get_parameters_by_path(**kwargs)
        for param in page.get("Parameters", []):
            name = param["Name"].rsplit("/", 1)[-1].upper()
            os.environ.setdefault(name, param["Value"])
            count += 1
        token = page.get("NextToken")
        if not token:
            return count
        kwargs["NextToken"] = token
