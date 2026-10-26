# #7a 讓後端能在 Lambda 上執行 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal：** 同一份 backend image 能以 `api`（Mangum）和 `jobs`（查價／重寄／維護）兩種 Lambda handler 執行，機密從 SSM 讀取，並加上來源標頭檢查與請求大小上限；不碰 AWS。

**Architecture：** `app/lambda_handlers.py` 在冷啟動時先呼叫 `app/core/secrets.py` 把 SSM 參數寫進環境變數，再 import app。三個 `app/jobs/*.py` 抽出 `run_*()` 讓命令列與 Lambda 共用。`app/core/middleware.py` 的兩個純 ASGI middleware 在 `create_app()` 掛上。`ENV=prod` 時 engine 用 NullPool。

**Tech Stack：** FastAPI、Mangum、boto3（SSM）、SQLAlchemy async、pytest、uv。

**Spec：** [docs/superpowers/specs/2026-10-26-m1-lambda-ready-design.md](../specs/2026-10-26-m1-lambda-ready-design.md)

## Global Constraints
- 測試不連 AWS：SSM 一律用假的 client
- `SSM_PARAMETER_PATH` 沒設時，行為和現在完全一樣（本機、CI、docker compose）
- `python -m app.jobs.*` 的輸出與 exit code 不變
- 請求大小上限 65536 bytes；回應 `413 {"detail": "請求內容太大"}`；來源不符回 `403 {"detail": "Forbidden"}`
- mypy strict、ruff（line-length 100）要過；新增的 model 規則不適用（沒有新表）
- 文件、註解用繁體中文；commit 用 Conventional Commits，結尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 本機跑 pytest 前要先啟動 Postgres 容器（`docker start farewatch-postgres-1`）

## Review Focus
1. Lambda 冷啟動的 import 順序：`app.main` 在 import 時就會 `create_app()` → 讀 Settings；若 SSM 還沒載入就 import，會因為缺 `JWT_SECRET` 啟動失敗 → Task 4 用子行程測試「設了 `SSM_PARAMETER_PATH` 時先讀 SSM 才 import app.main」
2. jobs 在同一個暖機的 Lambda 連續執行兩次（兩次 `asyncio.run`）不能因為連線綁在舊 event loop 而失敗 → Task 1 的 NullPool 測試＋Task 4 連續呼叫兩次 handler 的測試
3. chunked 上傳（沒有 Content-Length）超過上限時要回 413，不能先把整個 body 讀進記憶體 → Task 2 測試
4. `OriginVerifyMiddleware` 擋的是所有路徑，包括 `/api/v1/health`；CloudFront 以外的請求一律 403 → Task 2 測試 health 也被擋
5. SSM 參數超過一頁（`NextToken`）時要全部讀完，漏讀會變成缺設定 → Task 3 測試

---

### Task 1: 正式環境設定與 NullPool

**Files:**
- Modify: `backend/app/core/config.py`
- Modify: `backend/app/db/session.py`
- Test: `backend/tests/test_config.py`、`backend/tests/test_db.py`（新增測試；檔案已存在）

**Interfaces:**
- Produces：`Settings.origin_verify_secret: SecretStr | None = None`；`Settings` 在 `env == "prod"` 且 `"localhost" in app_base_url` 時驗證失敗，訊息含 `APP_BASE_URL`；`get_engine()` 在 prod 時 `engine.pool` 是 `NullPool`

- [ ] **Step 1: 寫失敗的測試**

`test_config.py`（沿用檔內的 `URL` 與 monkeypatch 寫法，記得 `setenv("JWT_SECRET", ...)`）：
```python
def test_prod_rejects_localhost_base_url(...):  # ENV=prod，APP_BASE_URL 未設（預設 localhost）→ ValidationError，str(e) 含 "APP_BASE_URL"
def test_prod_accepts_real_base_url(...):       # ENV=prod，APP_BASE_URL=https://farewatch.example → 通過
def test_origin_verify_secret_default_none(...):  # 未設 → s.origin_verify_secret is None
```
`test_db.py`：
```python
def test_prod_engine_uses_null_pool(monkeypatch):
    # setenv ENV=prod、APP_BASE_URL=https://farewatch.example；get_settings/get_engine 都 cache_clear()
    # assert isinstance(get_engine().pool, NullPool)
    # 結束時（try/finally 或 fixture）再 cache_clear() 兩者，恢復成測試環境的 engine
def test_local_engine_is_pooled(...):  # 預設環境 → not isinstance(get_engine().pool, NullPool)
```

- [ ] **Step 2: 執行，確認失敗**

Run（在 `backend/`）：`uv run pytest tests/test_config.py tests/test_db.py -q`
Expected：新測試 FAIL（prod 沒有被擋、pool 不是 NullPool、沒有 `origin_verify_secret` 屬性）

- [ ] **Step 3: 實作**（介面見 Interfaces）
  - `config.py`：新增欄位與一個 `model_validator(mode="after")`，風格跟 `_serpapi_needs_key` 一樣
  - `session.py`：prod 時 `create_async_engine(url, connect_args=CONNECT_ARGS, poolclass=NullPool)`；其他環境照舊帶 `pool_pre_ping=True`。註解寫明原因（Lambda 凍結後連線會斷、每次 `asyncio.run` 是新 loop）

- [ ] **Step 4: 執行，確認通過；全部測試也要過**

Run：`uv run pytest -q`
Expected：全部 PASS

- [ ] **Step 5: Commit**
```bash
git add backend
git commit -m "feat: 正式環境檢查 APP_BASE_URL，連線改用 NullPool"
```

---

### Task 2: 來源標頭與請求大小 middleware

**Files:**
- Create: `backend/app/core/middleware.py`
- Modify: `backend/app/main.py`（`create_app()` 掛上）
- Test: `backend/tests/test_middleware.py`

**Interfaces:**
- Consumes：Task 1 的 `Settings.origin_verify_secret`
- Produces：
  - `class OriginVerifyMiddleware:` `__init__(self, app: ASGIApp, secret: str | None)`、`async __call__(scope, receive, send)`
  - `class BodySizeLimitMiddleware:` `__init__(self, app: ASGIApp, max_bytes: int = MAX_BODY_BYTES)`；`MAX_BODY_BYTES = 65_536`
  - `create_app()` 依序掛上：外層 `OriginVerifyMiddleware`（secret 取 `get_settings().origin_verify_secret`，有值時用 `.get_secret_value()`），內層 `BodySizeLimitMiddleware`
  - `ASGIApp` 等型別用 `starlette.types`

- [ ] **Step 1: 寫失敗的測試** `tests/test_middleware.py`

測試對象：一個只有 `POST /echo`（回傳收到的 bytes 長度）和 `GET /ping` 的小 FastAPI app，包上要測的 middleware；用 `httpx.AsyncClient(transport=ASGITransport(app=...))`。
```python
# OriginVerify（secret="s3cret"）
async def test_origin_missing_header_403():   # GET /ping → 403，json == {"detail": "Forbidden"}
async def test_origin_wrong_header_403():     # x-origin-verify: nope → 403
async def test_origin_right_header_passes():  # x-origin-verify: s3cret → 200
async def test_origin_disabled_when_no_secret():  # secret=None，沒帶標頭 → 200

# BodySizeLimit（max_bytes=10）
async def test_body_content_length_over_limit_413():  # content=b"x"*11 → 413，json == {"detail": "請求內容太大"}
async def test_body_at_limit_passes():                # b"x"*10 → 200，回傳長度 10
async def test_chunked_body_over_limit_413():
    # content 用 async generator 分批送出 b"x"*6 兩次（httpx 不會帶 Content-Length）→ 413
async def test_chunked_body_under_limit_passes():     # 兩批各 4 bytes → 200，長度 8

# 掛在真正的 app 上（用 conftest 的 client fixture）
async def test_app_rejects_large_body(client):
    # POST /api/v1/auth/login，content=b"{" + b" "*70_000 + b"}"，headers content-type json → 413
async def test_app_origin_check_covers_health(monkeypatch):
    # setenv ORIGIN_VERIFY_SECRET=s3cret、get_settings.cache_clear()、create_app()
    # GET /api/v1/health 不帶標頭 → 403；帶對 → 200；結束時 cache_clear() 還原
```

- [ ] **Step 2: 執行，確認失敗**

Run：`uv run pytest tests/test_middleware.py -q`
Expected：FAIL，`app.core.middleware` 不存在

- [ ] **Step 3: 實作** `middleware.py` 與 `create_app()` 的掛載

非 `http` scope 直接交給下一層。回錯誤用 `starlette.responses.JSONResponse(...)(scope, receive, send)`。

chunked 的累計方式：包裝 `receive`，每收到 `http.request` 就累加 `len(body)`；超過上限時，若回應還沒開始，送出 413 並讓之後的 app 收不到更多 body。具體做法：
```python
# 在包裝的 receive 裡超過上限時 raise _TooLarge；__call__ 用 try/except 包住 await self.app(...)，
# 捕捉 _TooLarge 後，若 app 還沒送出 http.response.start（用包裝的 send 記錄），就回 413
```

- [ ] **Step 4: 執行，確認通過；全部測試也要過**

Run：`uv run pytest -q`、`uv run ruff check .`、`uv run ruff format --check .`、`uv run mypy`
Expected：全部通過

- [ ] **Step 5: Commit**
```bash
git add backend
git commit -m "feat: 檢查 CloudFront 來源標頭並限制請求大小"
```

---

### Task 3: 從 SSM 讀機密

**Files:**
- Modify: `backend/pyproject.toml`、`backend/uv.lock`（`uv add boto3`、`uv add --dev "boto3-stubs[ssm]"`）
- Create: `backend/app/core/secrets.py`
- Test: `backend/tests/test_secrets.py`

**Interfaces:**
- Produces：`load_ssm_parameters(client: SSMClient | None = None) -> int`
  - `SSM_PARAMETER_PATH` 未設或空字串 → 回 0，不建立 client、不 import boto3（boto3 在函式裡 import）
  - 有設時：`client` 為 None 才 `boto3.client("ssm")`；`get_parameters_by_path(Path=path, WithDecryption=True, Recursive=False)`，有 `NextToken` 就帶著繼續讀
  - 名稱轉換：取 `Name` 最後一段（`rsplit("/", 1)[-1]`）轉大寫；`os.environ` 已有該名稱時不覆蓋
  - 回傳讀到的參數數量（含沒寫入的）；client 的例外不攔截
  - `SSMClient` 型別來自 `mypy_boto3_ssm`，只在 `TYPE_CHECKING` 下 import
  - 這個模組不可 import `app.core.config`（要在 Settings 建立之前執行）

- [ ] **Step 1: 寫失敗的測試** `tests/test_secrets.py`

假 client：記錄每次呼叫的參數，依序回傳預先準備好的頁面。
```python
def test_no_path_does_nothing(monkeypatch):    # delenv SSM_PARAMETER_PATH；傳入假 client → 回 0，client 沒被呼叫
def test_loads_and_uppercases(monkeypatch):
    # path=/farewatch/prod/；一頁：jwt_secret=abc、serpapi_key=k1 → 回 2；
    # os.environ["JWT_SECRET"]=="abc"、["SERPAPI_KEY"]=="k1"（先 delenv 兩者，monkeypatch 會還原）
    # 呼叫參數含 Path="/farewatch/prod/"、WithDecryption=True
def test_reads_all_pages(monkeypatch):         # 兩頁（第一頁帶 NextToken="t1"）→ 第二次呼叫帶 NextToken="t1"，兩頁的參數都寫入
def test_existing_env_wins(monkeypatch):       # 先 setenv JWT_SECRET=local；SSM 給 jwt_secret=abc → 仍是 "local"
def test_client_error_propagates(monkeypatch): # 假 client 丟 RuntimeError → pytest.raises(RuntimeError)
```
寫進 `os.environ` 的值要在測試後清掉：測試開始時對會寫入的名稱先 `monkeypatch.delenv(..., raising=False)`，monkeypatch 結束時會一併還原。

- [ ] **Step 2: 執行，確認失敗**

Run：`uv run pytest tests/test_secrets.py -q`
Expected：FAIL，`app.core.secrets` 不存在

- [ ] **Step 3: 安裝套件並實作**

Run：`uv add boto3`、`uv add --dev "boto3-stubs[ssm]"`；然後寫 `secrets.py`（介面見 Interfaces）

- [ ] **Step 4: 執行，確認通過**

Run：`uv run pytest tests/test_secrets.py -q`、`uv run mypy`、`uv run ruff check .`
Expected：PASS，沒有型別錯誤

- [ ] **Step 5: Commit**
```bash
git add backend
git commit -m "feat: Lambda 冷啟動時從 SSM 讀機密"
```

---

### Task 4: Lambda handler 與 jobs 共用函式

**Files:**
- Modify: `backend/app/jobs/check_prices.py`、`send_notifications.py`、`maintenance.py`
- Create: `backend/app/lambda_handlers.py`
- Modify: `backend/pyproject.toml`、`backend/uv.lock`（`uv add mangum`）
- Modify: `backend/Dockerfile`（最後一行註解換成 `CMD ["app.lambda_handlers.api_handler"]`）
- Modify: `backend/tests/test_entrypoints.py`（清單加 `"app.lambda_handlers"`）
- Test: `backend/tests/test_lambda_handlers.py`

**Interfaces:**
- Consumes：Task 3 的 `load_ssm_parameters()`
- Produces：
  - `app.jobs.check_prices.run_check_prices() -> int`（原本 `_main` 的內容，回傳 exit code）
  - `app.jobs.send_notifications.run_send_notifications() -> SendSummary`（印出 `format_summary`）
  - `app.jobs.maintenance.run_maintenance() -> tuple[int, int]`（印出原本的訊息）
  - 三者都是 `async def`；`__main__` 區塊改為 `asyncio.run(run_*(), loop_factory=...)`，`check_prices` 照舊 `sys.exit(...)`
  - `app.lambda_handlers.api_handler`：`Mangum(app, lifespan="off")`
  - `app.lambda_handlers.jobs_handler(event: dict[str, Any], context: object) -> dict[str, Any]`
  - `class JobFailed(Exception)`
  - 模組頂端順序：`load_ssm_parameters()` → 再 `from app.main import app`（加 `# noqa: E402`）。註解說明順序的原因

jobs_handler 的回傳：
| job | 呼叫 | 回傳 |
|---|---|---|
| `check_prices` | `run_check_prices()`；非 0 → `raise JobFailed("查價失敗，exit code N")` | `{"job": "check_prices", "exit_code": 0}` |
| `send_notifications` | `run_send_notifications()` | `{"job": ..., "sent": , "failed": , "skipped": , "retry": }` |
| `maintenance` | `run_maintenance()` | `{"job": ..., "expired": , "activated": }` |
| 其他／缺少 | — | `raise ValueError(f"不認得的工作：{job!r}")` |

handler 內用 `asyncio.run(...)`（Lambda 是 Linux，不需要 Windows 的 loop_factory）。

- [ ] **Step 1: 寫失敗的測試** `tests/test_lambda_handlers.py`

用 `monkeypatch.setattr(app.lambda_handlers, "run_check_prices", fake)` 等方式替換三個 `run_*`（handler 要用模組層級的名稱呼叫它們，才能被替換）。
```python
def test_api_handler_health():
    # Lambda Function URL（payload v2.0）格式的假事件：
    # {"version": "2.0", "routeKey": "$default", "rawPath": "/api/v1/health", "rawQueryString": "",
    #  "headers": {"host": "x.lambda-url.ap-southeast-1.on.aws"},
    #  "requestContext": {"http": {"method": "GET", "path": "/api/v1/health", "protocol": "HTTP/1.1",
    #      "sourceIp": "1.2.3.4", "userAgent": "test"}, "stage": "$default", "requestId": "r", ...},
    #  "isBase64Encoded": False}
    # context 給一個簡單物件；assert resp["statusCode"] == 200、json.loads(resp["body"]) == {"status": "ok"}
def test_jobs_check_prices(monkeypatch):       # fake 回 0 → {"job": "check_prices", "exit_code": 0}
def test_jobs_check_prices_failure(monkeypatch):  # fake 回 1 → pytest.raises(JobFailed)
def test_jobs_send_notifications(monkeypatch): # fake 回 SendSummary(sent=2) → 結果 sent==2、其餘 0
def test_jobs_maintenance(monkeypatch):        # fake 回 (3, 1) → expired==3、activated==1
def test_jobs_unknown(monkeypatch):            # {"job": "nope"} 與 {} → ValueError
def test_jobs_twice_in_same_process(monkeypatch):
    # 同一個 fake 連續呼叫 handler 兩次都成功（確認每次用新的 asyncio.run，不殘留 loop）
def test_cold_start_loads_ssm_before_app():
    # 子行程（同 test_entrypoints 的 subprocess 寫法）：
    # 環境變數拿掉 JWT_SECRET、設 SSM_PARAMETER_PATH=/x/；子行程程式先 monkeypatch
    # app.core.secrets.load_ssm_parameters 的 boto3 —— 做法：在 -c 程式裡先
    # `import sys, types; fake = types.ModuleType("boto3"); fake.client = lambda name: FakeSSM()`
    # 放進 sys.modules["boto3"]，FakeSSM.get_parameters_by_path 回 jwt_secret
    # 再 `import app.lambda_handlers` → returncode == 0（沒有 SSM 就會因缺 JWT_SECRET 失敗）
```

- [ ] **Step 2: 執行，確認失敗**

Run：`uv run pytest tests/test_lambda_handlers.py -q`
Expected：FAIL，`app.lambda_handlers` 不存在

- [ ] **Step 3: 實作**：`uv add mangum`；抽出三個 `run_*`；寫 `lambda_handlers.py`；Dockerfile 加 CMD；`test_entrypoints.py` 加入新模組

- [ ] **Step 4: 執行，確認通過；全部檢查**

Run：`uv run pytest -q`、`uv run ruff check .`、`uv run ruff format --check .`、`uv run mypy`
Expected：全部通過

Run：`uv run python -m app.jobs.maintenance`（需要本機 DB 有 migrate 過的開發資料庫；`.env` 的 `DATABASE_URL`）
Expected：印出「每日維護完成：過期 N 個、啟用 M 個」，exit code 0

Run（repo 根目錄）：`docker build -t farewatch-backend:7a backend`
Expected：build 成功

- [ ] **Step 5: Commit**
```bash
git add backend
git commit -m "feat: api 與 jobs 的 Lambda handler"
```

---

### Task 5: 文件更新

**Files:**
- Modify: `docs/architecture.md`、`docs/02-design.md`、`docs/06-operations.md`、`docs/04-testing.md`、`docs/03-development.md`（有提到 SQS／notifier Lambda 才改）

- [ ] **Step 1: 改文件**（照 spec〈文件更新〉）
  - `architecture.md`：Mermaid 圖拿掉 `sqs`、`dlq`、`notifier`；`checker` 改名為 `jobs`（Lambda: jobs（查價、重寄、維護）），由 `sched` 叫醒，直接連到 `email`、`serp`、`db`；`lineapi` 先接在 `jobs`（M2）；`ssm` 連到 `api`、`jobs`。〈文件狀態〉加一行 2026-10-26；文末加〈2026-10-26 #7a 決策紀錄〉表格，列 spec〈設計決定〉的 SQS、Lambda 數量、機密來源、NullPool、請求大小上限五項
  - `02-design.md`：〈技術選型〉背景任務改成「EventBridge Scheduler（每天查價、查價後 1 小時與 3 小時重寄、每天維護）」；〈容器執行方式〉的 handler 改成 api／jobs；〈系統架構〉文字圖與時序圖拿掉 SQS、notifier，改成 jobs
  - `06-operations.md`：DLQ 那一列改成「jobs Lambda 執行失敗（Errors > 0）」；LINE 那一列的「DLQ 告警」改成「`alert_deliveries` 出現 failed」
  - `04-testing.md`：「SQS 重送不重複發送」改成「同時執行兩個重寄工作不會重複寄同一封信」
  - 全 repo 搜尋 `SQS`、`notifier Lambda`，`docs/superpowers/` 以外的殘留都要處理（`docs/superpowers/` 是歷史紀錄，不改）

- [ ] **Step 2: 檢查**

Run：在 repo 根目錄搜尋 `SQS|DLQ`（排除 `docs/superpowers/`）
Expected：只剩決策紀錄裡說明「拿掉 SQS」的文字

- [ ] **Step 3: Commit**
```bash
git add docs
git commit -m "docs: 拿掉 SQS，改成 api 與 jobs 兩個 Lambda"
```

---

### 收尾
- [ ] 在 python:3.14-slim 容器跑一次後端 pytest（Windows 本機、CI 是 Linux：`UV_PROJECT_ENVIRONMENT=/tmp/venv`、不複製 `.env`、`TEST_DATABASE_URL` 連 `host.docker.internal`）
- [ ] 本機 `docker compose -f deploy/docker-compose.yml --env-file backend/.env up -d --build api` 後 `GET http://localhost:8000/api/v1/health` 回 200（確認 uvicorn 覆寫入口仍正常）
- [ ] 最後一次整個分支的審查，然後 push、提供 compare 網址與 PR 說明
