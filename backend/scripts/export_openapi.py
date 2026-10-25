"""輸出 API 規格給前端產生型別。不連資料庫，也不需要 .env。

用法（在 backend/ 下）：
    uv run python scripts/export_openapi.py

寫到 frontend/openapi.json；之後在 frontend/ 執行 npm run gen:api。
CI 會重新輸出一次，和 commit 進去的版本不一致就失敗。
"""

import json
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
OUT_PATH = BACKEND_DIR.parent / "frontend" / "openapi.json"

# 直接執行腳本時 sys.path 只有 scripts/，要自己加上 backend/ 才 import 得到 app
sys.path.insert(0, str(BACKEND_DIR))

from app.main import create_app  # noqa: E402


def main() -> None:
    spec = create_app().openapi()
    text = json.dumps(spec, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    OUT_PATH.parent.mkdir(exist_ok=True)
    # 固定用 LF，Windows 和 CI 產生的檔案才會一模一樣
    OUT_PATH.write_text(text, encoding="utf-8", newline="\n")
    print(f"已寫入 {OUT_PATH}")


if __name__ == "__main__":
    main()
