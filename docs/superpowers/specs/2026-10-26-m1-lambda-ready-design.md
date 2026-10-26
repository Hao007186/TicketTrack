# M1 子專案 #7a：讓後端能在 Lambda 上執行 — 設計

日期：2026-10-26
狀態：待審閱
相關文件：[architecture.md](../../architecture.md)、[02-design.md](../../02-design.md)、[05-deployment.md](../../05-deployment.md)、[#5 通知設計](2026-10-24-m1-alerts-design.md)

## 背景與目標
M1 的 #7（Terraform＋部署）拆成三段：
- **7a（本文件）**：讓程式能在 Lambda 上跑
- **7b**：用 Terraform 建 AWS 資源、第一次手動部署、用 SES 實際寄信
- **7c**：GitHub Actions 自動部署

7a 只改後端程式和文件，在本機開發與測試，不碰 AWS。

**完成標準：**
- 下方〈測試〉列出的案例全部通過，測試不連 AWS
- `docker build` 成功，image 的預設入口是 api 的 Lambda handler
- 本機 docker compose（uvicorn）和三個 `python -m app.jobs.*` 指令照常可用
- PR 上的 CI 全綠

## 不在範圍內
Terraform 與任何 AWS 資源（7b）；Lambda 的記憶體、逾時、排程時間（7b）；SES 設定與實際寄信（7b）；GitHub Actions 部署（7c）；LINE webhook（M2）。

## 設計決定
| 項目 | 決定 | 理由 |
|---|---|---|
| SQS 與 notifier Lambda | **拿掉**。查價工作查完直接寄信（#5 已經這樣做）；另外排兩次「只重寄」的工作 | 待寄的信本來就記在 DB（寄件匣），SQS 只剩叫醒的用途；少一個服務、一個 Lambda、一組 DLQ。重寄只排兩次，避免頻繁叫醒 Neon、消耗免費的運算時數 |
| Lambda 數量 | 兩個：`api`、`jobs`，同一份 image、不同 handler | jobs 用事件內容決定工作，不必每種工作各建一個 Lambda |
| API 轉接 | Mangum（`lifespan="off"`） | 02-design 已選定；現有 FastAPI 程式不用改。app 沒有 lifespan 事件 |
| 機密來源 | Lambda 冷啟動時讀 SSM Parameter Store 指定路徑下的所有參數，寫進環境變數後才建立 Settings | 機密不出現在 Lambda 設定畫面與 Terraform state；本機不受影響 |
| 正式環境的 DB 連線池 | `ENV=prod` 時用 SQLAlchemy `NullPool`（每次用完就關） | Lambda 凍結後保留的連線常已斷線；jobs 每次執行是新的 event loop，舊連線不能跨 loop 使用；Neon pooler 本來就負責連線池 |
| 繞過 CloudFront 的請求 | middleware 比對 `X-Origin-Verify` 標頭，不符回 403；未設定密碼時不檢查 | 02-design 已選定 |
| 請求大小上限 | 64 KB，超過回 413 | #1 留下的待辦；目前最大的請求（新增追蹤）不到 1 KB |
| 寄信途中被 Lambda 逾時中斷 | 不改程式；7b 把 jobs 的逾時設得比最壞情況長 | 寄信與 SerpApi 都已有逾時設定，最壞情況可以算出來（#5 留下的待辦） |

## 程式結構
```
backend/app/
├─ lambda_handlers.py      api_handler、jobs_handler
├─ core/secrets.py         load_ssm_parameters()
├─ core/middleware.py      OriginVerifyMiddleware、BodySizeLimitMiddleware
├─ jobs/check_prices.py    抽出 run_check_prices() -> int（exit code）
├─ jobs/send_notifications.py  抽出 run_send_notifications() -> SendSummary
└─ jobs/maintenance.py     抽出 run_maintenance() -> tuple[int, int]
```

### Lambda handler（`app/lambda_handlers.py`）
- 模組載入時（冷啟動）先呼叫 `load_ssm_parameters()`，再建立 app，讓 Settings 讀得到機密
- `api_handler = Mangum(create_app(), lifespan="off")`
- `jobs_handler(event, context)`：讀 `event["job"]`
  - `check_prices` → `run_check_prices()`；回傳非 0 時丟出 `JobFailed`，讓 Lambda 記錄為執行失敗
  - `send_notifications` → `run_send_notifications()`
  - `maintenance` → `run_maintenance()`
  - 其他值或沒有 `job` → 丟出 `ValueError`
  - 每次用 `asyncio.run()` 執行，回傳一個簡短的結果 dict（寫進 CloudWatch log）
- Dockerfile 最後加 `CMD ["app.lambda_handlers.api_handler"]`；jobs Lambda 在 7b 用 `image_config.command` 覆寫成 `app.lambda_handlers.jobs_handler`

`python -m app.jobs.*` 的命令列行為不變（印出的摘要、exit code 都一樣），只是改呼叫抽出來的函式。

### 讀 SSM（`app/core/secrets.py`）
- `load_ssm_parameters(client=None) -> int`：環境變數 `SSM_PARAMETER_PATH` 沒設時直接回 0，不 import boto3、也不連網路（本機和測試不受影響）
- 有設時用 `get_parameters_by_path(Path=..., WithDecryption=True, Recursive=False)` 分頁讀完；參數名稱去掉路徑前綴、轉大寫後寫進 `os.environ`（例如 `/farewatch/prod/jwt_secret` → `JWT_SECRET`）
- **已經存在的環境變數不覆蓋**，方便臨時用 Lambda 環境變數蓋掉某個值
- 回傳讀到的參數數量；讀取失敗直接丟出例外，讓 Lambda 啟動失敗，而不是帶著缺漏的設定跑
- 新增相依套件 `boto3`、`mangum`

### 設定（`app/core/config.py`）
- 新增 `origin_verify_secret: SecretStr | None = None`
- 新增驗證：`env == "prod"` 時 `app_base_url` 不能包含 `localhost`，否則啟動失敗

### 資料庫（`app/db/session.py`）
`get_engine()`：`env == "prod"` 時加上 `poolclass=NullPool`（此時不帶 `pool_pre_ping`）；其他環境維持現狀。

### Middleware（`app/core/middleware.py`，在 `create_app()` 掛上）
用純 ASGI middleware（不用 `BaseHTTPMiddleware`），只處理 `http` scope。
- **`OriginVerifyMiddleware(app, secret)`**：`secret` 為 None 時直接放行。否則讀 `x-origin-verify` 標頭，用 `hmac.compare_digest` 比對，不符回 `403 {"detail": "Forbidden"}`
- **`BodySizeLimitMiddleware(app, max_bytes=65536)`**：
  - `Content-Length` 大於上限 → 直接回 `413 {"detail": "請求內容太大"}`，不讀 body
  - 沒有 `Content-Length`（chunked）時，包裝 `receive` 邊收邊累計，超過上限就停止並回 413
- 順序：先檢查來源，再檢查大小（外部請求不必花力氣讀 body）

## 文件更新
- `architecture.md` 架構圖：拿掉 SQS、DLQ、notifier Lambda，改成 `jobs` Lambda（查價、重寄、維護），並加一筆決策紀錄
- `02-design.md`〈技術選型〉的背景任務改成「EventBridge Scheduler」；〈系統架構〉與時序圖拿掉 SQS
- `06-operations.md`：DLQ 告警改成「jobs Lambda 執行失敗」告警；LINE 那一列改成依 `alert_deliveries.failed` 處理
- `04-testing.md`：「SQS 重送不重複發送」改成「同時執行兩個重寄工作不會重複寄同一封信」（#5 已有測試）
- `03-development.md` 如有提到 SQS 或 notifier Lambda 也一併更新

## 測試
- **api handler**：用 Lambda Function URL 格式的假事件呼叫 `GET /api/v1/health`，回 200 與 `{"status": "ok"}`
- **jobs handler**（把三個 `run_*` 換成假的函式）：三種工作各自呼叫對應函式；未知工作與缺少 `job` 丟出 `ValueError`；`run_check_prices` 回 1 時丟出 `JobFailed`
- **jobs 函式**：現有的 jobs 相關測試改測抽出來的 `run_*`，行為不變
- **SSM**：用假的 client（不連 AWS）：沒設路徑時不呼叫 client 且回 0；分頁讀完並轉成大寫的環境變數；已存在的環境變數不被覆蓋；client 丟出例外時往外丟
- **OriginVerify**：有設密碼時，沒帶標頭 403、帶錯 403、帶對 200；沒設密碼時沒帶也 200
- **BodySizeLimit**：`Content-Length` 超過上限回 413；剛好等於上限可以通過；沒有 `Content-Length` 的 chunked body 超過上限回 413；一般 JSON 請求不受影響
- **設定**：`ENV=prod` 且 `APP_BASE_URL` 含 localhost 時驗證失敗；改成正式網址就通過
- **DB**：`ENV=prod` 時 engine 用 `NullPool`，其他環境不是
- **Docker**：CI 的 docker-build 照常通過
