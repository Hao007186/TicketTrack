# M1 子專案 #7b：Terraform 建立正式環境與第一次部署 — 設計

日期：2026-10-26
狀態：待審閱
相關文件：[architecture.md](../../architecture.md)、[02-design.md](../../02-design.md)、[05-deployment.md](../../05-deployment.md)、[06-operations.md](../../06-operations.md)、[#7a 設計](2026-10-26-m1-lambda-ready-design.md)

## 背景與目標
#7 拆成 7a（程式能在 Lambda 上跑，已完成）、**7b（本文件）**、7c（GitHub Actions 自動部署）。

7b 用 Terraform 建出正式環境的所有雲端資源，由使用者在自己的電腦上手動完成第一次部署，網站正式上線，並用 SES 寄出第一封真的價格通知信。

**完成標準（驗收清單）：**
- 打開 `https://hao007186.com` 看得到網站；`https://hao007186.com/api/v1/health` 回 200
- 直接打 Lambda Function URL 回 403
- 示範帳號能登入；註冊一個真的帳號能新增追蹤
- 新增一個目標價很高的追蹤，手動觸發一次查價（花 1 次 SerpApi 額度），收到站內通知和一封從 `noreply@hao007186.com` 寄出的 Email，信中連結指向 `https://hao007186.com`
- 告警信箱收到 SNS 訂閱確認信並確認；AWS Budgets 的 US$1 告警已建立
- `terraform fmt -check`、`terraform validate` 通過；後端 pytest 全部通過

## 不在範圍內
GitHub Actions 自動部署、OIDC、CI 的 `terraform plan`（7c）；LINE（M2）；Neon 用 Terraform 管理（手動建立即可）；完整監控與 Admin 用量頁（M4）；`price_daily_lows`。

## 設計決定
| 項目 | 決定 | 理由 |
|---|---|---|
| 網址 | 網站放根網域 `https://hao007186.com`；寄件人 `noreply@hao007186.com` | 網域只給 FareWatch 用 |
| 區域 | 全部在 ap-southeast-1；只有 CloudFront 用的 ACM 憑證在 us-east-1 | 和 Neon 同區；CloudFront 規定憑證必須在 us-east-1 |
| 寄信 | **SES API**（boto3 `send_email`），靠 jobs Lambda 的 IAM 權限；新增 `EMAIL_SENDER=ses` | 不需要任何長期密碼；SMTP 寄信器保留給本機或備援 |
| 本機登入 AWS | **IAM Identity Center**（`aws sso login`，臨時金鑰） | 電腦上不存長期金鑰；AWS 官方建議 |
| Cloudflare 代理 | DNS only（灰色雲朵），不經過 Cloudflare 代理 | CloudFront 已經是 CDN；雙層代理會讓憑證與快取更複雜 |
| SPA 路由 | CloudFront Function（viewer request）把沒有副檔名的路徑改寫成 `/index.html`，只套用在 S3 的 behavior | CloudFront 的自訂錯誤回應會套到整個 distribution，連 API 的 404 也被改成 index.html |
| `/api/*` | 轉給 Function URL；快取政策 `CachingDisabled`，來源請求政策 `AllViewerExceptHostHeader`；加自訂標頭 `X-Origin-Verify` | API 不快取、cookie 與 query 都要轉送；Function URL 需要自己的 Host |
| 機密 | `origin_verify_secret` 由 Terraform 用 `random_password` 產生並寫進 SSM（它本來就會出現在 CloudFront 設定與 state 裡）；其他機密由使用者用 AWS CLI 填進 SSM，Terraform 不碰 | 資料庫密碼、JWT 密鑰、SerpApi key 不進 Terraform state |
| state | S3 backend，`use_lockfile = true`（S3 原生鎖，不需要 DynamoDB）；bucket 手動建立、開版本控制 | 避免雞生蛋；版本控制可救回壞掉的 state |
| 第一次部署 | 兩段式：先 `-target` 建 ECR → 推 image → 再 apply 全部 | Lambda 建立時 image 必須已存在 |
| 排程時間 | 台灣時間：每天 08:00 查價、09:00 與 11:00 重寄、00:10 維護 | 早上收到通知；維護在換日後執行 |

## Terraform 結構（`infra/terraform/`）
| 檔案 | 內容 |
|---|---|
| `versions.tf` | Terraform ≥ 1.10、providers：`aws`、`cloudflare`、`random`；版本用 `~>` 鎖主版本，`.terraform.lock.hcl` commit 進 repo |
| `backend.tf` | S3 backend（bucket 名稱用 `-backend-config` 傳入，不寫死帳號資訊） |
| `providers.tf` | `aws`（ap-southeast-1）、`aws.us_east_1`（alias，憑證用）、`cloudflare`（token 從變數） |
| `variables.tf` | `domain`（預設 `hao007186.com`）、`image_tag`、`alert_email`、`cloudflare_api_token`（sensitive）、`cloudflare_zone_id` |
| `ecr.tf` | repository `farewatch-backend`；lifecycle 只保留最新 3 個 image |
| `lambda.tf` | `api`、`jobs` 兩個 Lambda（arm64、image、512 MB；api 逾時 30 秒、jobs 900 秒）；jobs 用 `image_config.command = ["app.lambda_handlers.jobs_handler"]`；api 的 Function URL（auth NONE）；log group 保留 14 天；IAM role：兩者都能讀 `/farewatch/prod/*` 的 SSM（含 KMS 解密 AWS 管理金鑰）與寫 log，jobs 另外能 `ses:SendEmail`（限定寄件 identity） |
| `frontend.tf` | S3 bucket（封鎖公開、開版本控制）＋ OAC；CloudFront（兩個 origin、兩個 behavior、CloudFront Function、`aliases = [domain]`、TLS 1.2）；ACM 憑證（us-east-1，DNS 驗證） |
| `dns.tf` | Cloudflare 記錄：根網域 CNAME → CloudFront（Cloudflare 會自動攤平）、ACM 驗證 CNAME、SES DKIM 3 筆 CNAME、MAIL FROM 的 MX 與 SPF TXT、DMARC TXT（`v=DMARC1; p=none`）；全部 `proxied = false` |
| `ses.tf` | `aws_sesv2_email_identity`（網域）＋ Easy DKIM；MAIL FROM 網域 `mail.hao007186.com` |
| `scheduler.tf` | 4 個 `aws_scheduler_schedule`（`schedule_expression_timezone = "Asia/Taipei"`），target 是 jobs Lambda，input 為 `{"job": "..."}`；scheduler 專用 IAM role 只能 invoke jobs |
| `ssm.tf` | `random_password` → `/farewatch/prod/origin_verify_secret`（SecureString） |
| `monitoring.tf` | SNS topic ＋ email 訂閱；告警：jobs Errors > 0（5 分鐘）、api Errors 5 分鐘 > 5、jobs 一天內 Invocations < 1（period 86400 秒、`treat_missing_data = breaching`，代表排程沒在跑）；`aws_budgets_budget` 月費 US$1、達 100% 寄信 |
| `outputs.tf` | CloudFront 網域、distribution ID、Function URL、ECR repository URL、S3 bucket 名稱 |

Lambda 環境變數（不是機密）：`ENV=prod`、`SSM_PARAMETER_PATH=/farewatch/prod/`、`APP_BASE_URL=https://hao007186.com`、`EMAIL_SENDER=ses`、`EMAIL_FROM=FareWatch <noreply@hao007186.com>`、`LOG_LEVEL=INFO`。

使用者填進 SSM 的參數（SecureString，名稱用底線）：`database_url`（Neon pooler）、`jwt_secret`、`serpapi_key`、`price_provider`（`serpapi`）。

`terraform.tfvars`、`.terraform/`、`*.tfstate*` 加進 `.gitignore`；repo 裡放 `terraform.tfvars.example`。

## 程式碼改動：SES 寄信器
- `app/core/config.py`：`email_sender` 加上 `"ses"`；`ses` 時必須設定 `EMAIL_FROM`（不需要 SMTP 欄位）
- `app/modules/notifications/email.py`：新增 `SesEmailSender(from_addr: str, client: SESV2Client | None = None)`
  - `send()` 用 `asyncio.to_thread` 呼叫 `sesv2.send_email(FromEmailAddress=..., Destination={"ToAddresses": [to]}, Content={"Simple": {"Subject": {...UTF-8}, "Body": {"Text": {...UTF-8}}}})`
  - boto3 的 `ClientError`／`BotoCoreError` 轉成 `EmailError`（訊息只留錯誤類型與 AWS 錯誤碼與訊息，`from None`）
  - client 在第一次寄信時才建立（`boto3.client("sesv2")`），本機與測試不連 AWS
- `get_email_sender()`：`ses` → `SesEmailSender(settings.email_from)`
- 新增相依：`boto3-stubs[sesv2]`（dev）

## 部署腳本（`infra/scripts/`，bash，Git Bash 與之後的 CI 都能用）
- `push-image.sh <tag>`：ECR 登入 → `docker buildx build --platform linux/arm64 --provenance=false` → push；印出 image URI
- `deploy-frontend.sh`：`npm ci && npm run build` → `aws s3 sync dist/ s3://<bucket> --delete` → `aws cloudfront create-invalidation --paths "/*"`；bucket 與 distribution ID 從 `terraform output` 取得
- 兩者都 `set -euo pipefail`，用環境變數 `AWS_PROFILE` 指定登入身分

## 一次性手動準備（寫進 `docs/deploy-runbook.md`）
1. 安裝 Terraform、AWS CLI v2
2. 開啟 IAM Identity Center，建管理員使用者並指派 `AdministratorAccess` permission set；`aws configure sso` 建 profile `farewatch`；之後每次操作前 `aws sso login --profile farewatch`
3. 建 state bucket：`farewatch-tfstate-<帳號 ID>`（ap-southeast-1、開版本控制、封鎖公開）
4. Neon：註冊、建立 ap-southeast-1 專案（Postgres 16）、記下 pooler 與直連兩組連線字串
5. Cloudflare：建 API token（權限 Zone → DNS → Edit，限定 `hao007186.com`）；記下 Zone ID
6. 用 AWS CLI 把四個機密填進 SSM（runbook 附產生 `jwt_secret` 的指令）
7. 複製 `terraform.tfvars.example` 成 `terraform.tfvars` 並填值
8. SES：在主控台驗證自己的信箱（沙盒期間只能寄給驗證過的地址），並申請解除沙盒（production access）

## 第一次部署順序
1. `terraform init -backend-config=...`
2. `terraform apply -target=aws_ecr_repository.backend`
3. `infra/scripts/push-image.sh <git SHA>`
4. `terraform apply -var image_tag=<git SHA>`（先看 plan）；等 ACM 與 SES 驗證完成
5. 用 Neon 直連網址：`alembic upgrade head` → `python -m app.seeds.reference` → `python -m app.seeds.demo`
6. `infra/scripts/deploy-frontend.sh`
7. 跑驗收清單；查價用 `aws lambda invoke --function-name farewatch-jobs --payload '{"job":"check_prices"}'`

## 文件更新
- 新增 `docs/deploy-runbook.md`：手動準備＋第一次部署＋之後的更新方式（換 image、換前端、換機密）＋拆除方式（`terraform destroy`）
- `02-design.md`：技術選型的 Email 改成 SES API；系統架構補上 Cloudflare DNS only、CloudFront Function
- `05-deployment.md`：〈一次性手動設定〉的 Resend 改成 SES、補上 Identity Center、Neon、state bucket；成本控管的 Resend 改成 SES
- `06-operations.md`：Resend 相關的告警與 runbook 改成 SES（退信／投訴看 SES 主控台、沙盒）
- `architecture.md`：架構圖的 Email 改成 SES；新增〈2026-10-26 #7b 決策紀錄〉

## 測試
- **SES 寄信器（pytest，假的 client）**：寄出的參數正確（寄件人、收件人、主旨、內文、UTF-8）；`ClientError` 轉成 `EmailError` 且訊息含錯誤碼；`get_email_sender()` 在 `ses` 時回 `SesEmailSender`
- **設定**：`EMAIL_SENDER=ses` 缺 `EMAIL_FROM` 時驗證失敗；不需要 SMTP 欄位
- **Terraform**：`terraform fmt -check -recursive`、`terraform validate`（`init -backend=false`）
- **部署後**：〈完成標準〉的驗收清單
