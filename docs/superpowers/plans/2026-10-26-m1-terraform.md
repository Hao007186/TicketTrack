# #7b Terraform 建立正式環境與第一次部署 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal：** 用 Terraform 在 ap-southeast-1 建出 FareWatch 的正式環境（`https://hao007186.com`），由使用者手動完成第一次部署，並用 SES API 寄出第一封真的通知信。

**Architecture：** 後端加一個 `SesEmailSender`（boto3 sesv2，靠 Lambda IAM 權限）。`infra/terraform/` 是單一 root module，依用途分檔；`infra/scripts/` 兩個 bash 腳本負責推 image 與上傳前端。Task 1～5 是 repo 內的程式與文件，用 pytest、node、`terraform validate`、shellcheck 驗證；Task 6 是和使用者一起做的手動準備與第一次部署。

**Tech Stack：** Terraform（hashicorp/aws、cloudflare/cloudflare、hashicorp/random）、AWS（Lambda、ECR、S3、CloudFront、ACM、SES v2、EventBridge Scheduler、SSM、CloudWatch、SNS、Budgets）、boto3、bash。

**Spec：** [docs/superpowers/specs/2026-10-26-m1-terraform-design.md](../specs/2026-10-26-m1-terraform-design.md)

## Global Constraints
- 網域 `hao007186.com`（根網域），寄件人 `FareWatch <noreply@hao007186.com>`，MAIL FROM `mail.hao007186.com`
- 區域 ap-southeast-1；只有 CloudFront 的 ACM 憑證在 us-east-1（provider alias `aws.us_east_1`）
- 資源名稱前綴 `farewatch`（例如 `farewatch-api`、`farewatch-jobs`、`farewatch-backend`）；所有 AWS 資源加 tag `Project = "farewatch"`（provider `default_tags`）
- SSM 路徑 `/farewatch/prod/`，參數名稱用底線
- 除了 `origin_verify_secret`，Terraform 不建立、不讀取任何機密的值
- Lambda：arm64、image、512 MB；api 逾時 30 秒、jobs 900 秒；log 保留 14 天
- 排程（Asia/Taipei）：08:00 `check_prices`、09:00 與 11:00 `send_notifications`、00:10 `maintenance`
- Cloudflare 記錄一律 `proxied = false`
- 本機沒有 terraform：fmt／validate 用 `docker run --rm -v "<repo>/infra/terraform:/w" -w /w hashicorp/terraform:latest ...`；shellcheck 用 `koalaman/shellcheck:stable`
- `terraform.tfvars`、`.terraform/`、`*.tfstate`、`*.tfstate.*` 不進 git；`.terraform.lock.hcl` 要 commit
- 文件、註解用繁體中文；commit 用 Conventional Commits，結尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 任何會建立、修改、刪除雲端資源或花錢的指令（`terraform apply`、`aws ... create/put`、push image、SerpApi 查價）都由使用者確認後才執行

## Review Focus
1. SPA 改寫：`/watches/123`、`/login?next=/x` 要改成 `/index.html`；`/assets/index-abc.js`、`/favicon.svg` 不能被改寫 → Task 3 的 node 測試
2. SES 沙盒期間寄給未驗證的收件人會回 `MessageRejected`，必須變成 `EmailError` 讓 notifier 重試／標 failed，而不是讓整個 jobs 執行失敗 → Task 1 測試
3. CloudFront 帶的 `X-Origin-Verify` 和 Lambda 從 SSM 讀到的必須是同一個值（同一個 `random_password`），否則網站所有 API 都 403 → Task 2／3 共用 `random_password.origin_verify`；Task 6 驗收「經由網域 health 200、直接打 Function URL 403」
4. 登入後重新整理頁面仍維持登入（refresh cookie 經 CloudFront 轉送與回傳）→ `/api/*` 用 `AllViewerExceptHostHeader`；Task 6 驗收加一項
5. 排程時區：cron 必須搭配 `schedule_expression_timezone = "Asia/Taipei"`，否則會在 UTC 08:00（台灣 16:00）查價 → Task 4 在 `terraform validate` 外再用 grep 確認每個 schedule 都有 timezone；Task 6 驗收用 `aws scheduler get-schedule` 檢查

---

### Task 1: SES 寄信器

**Files:**
- Modify: `backend/app/core/config.py`、`backend/app/modules/notifications/email.py`
- Modify: `backend/pyproject.toml`、`backend/uv.lock`（`uv add --dev "boto3-stubs[ssm,sesv2]"`）
- Test: `backend/tests/notifications/test_email.py`、`backend/tests/test_config.py`

**Interfaces:**
- Produces：
  - `Settings.email_sender: Literal["console", "smtp", "ses"]`；`ses` 時缺 `EMAIL_FROM` → 驗證失敗，訊息含 `EMAIL_FROM`；不要求任何 `SMTP_*`
  - `class SesEmailSender:` `__init__(self, from_addr: str, client: SESV2Client | None = None)`、`async send(self, message: EmailMessage) -> None`
  - `get_email_sender()` 在 `ses` 時回 `SesEmailSender(settings.email_from)`

- [ ] **Step 1: 寫失敗的測試**

`test_email.py`（假 client 記錄 `send_email` 的 kwargs；用 `botocore.exceptions.ClientError({"Error": {"Code": "MessageRejected", "Message": "Email address is not verified."}}, "SendEmail")` 製造錯誤）：
```python
async def test_ses_sender_sends():
    # SesEmailSender("FareWatch <noreply@hao007186.com>", client=fake).send(MESSAGE)
    # kwargs["FromEmailAddress"] == "FareWatch <noreply@hao007186.com>"
    # kwargs["Destination"] == {"ToAddresses": [MESSAGE.to]}
    # kwargs["Content"]["Simple"]["Subject"] == {"Data": MESSAGE.subject, "Charset": "UTF-8"}
    # kwargs["Content"]["Simple"]["Body"] == {"Text": {"Data": MESSAGE.text, "Charset": "UTF-8"}}
async def test_ses_rejected_becomes_email_error():
    # fake 丟上面的 ClientError → pytest.raises(EmailError)，str(e) 含 "MessageRejected"
    # e.__cause__ is None and e.__suppress_context__ is True
async def test_ses_botocore_error_becomes_email_error():
    # fake 丟 botocore.exceptions.EndpointConnectionError(endpoint_url="https://x") → EmailError
async def test_get_email_sender_ses():
    # Settings(_env_file=None, email_sender="ses", email_from="FareWatch <noreply@hao007186.com>")
    # → isinstance(..., SesEmailSender)；建立時不連 AWS（client 延遲到第一次 send 才建立）
```
`test_config.py`：
```python
def test_ses_requires_email_from(monkeypatch):  # EMAIL_SENDER=ses、delenv EMAIL_FROM → ValidationError 含 "EMAIL_FROM"
def test_ses_needs_no_smtp_fields(monkeypatch): # EMAIL_SENDER=ses、EMAIL_FROM 有值、SMTP_* 都 delenv → 通過
```

- [ ] **Step 2: 執行，確認失敗**

Run（在 `backend/`，Postgres 容器要開著）：`uv run pytest tests/notifications/test_email.py tests/test_config.py -q`
Expected：新測試 FAIL（`SesEmailSender` 不存在、`ses` 不是合法值）

- [ ] **Step 3: 實作**（介面見 Interfaces）
  - `uv add --dev "boto3-stubs[ssm,sesv2]"`
  - `SesEmailSender.send` 用 `asyncio.to_thread` 呼叫同步的 `_send`；client 為 None 時在 `_send` 裡 `boto3.client("sesv2")` 並快取在 instance 上
  - 錯誤訊息格式：`ClientError` → `f"{code}: {message}"`；`BotoCoreError` → `f"{type(e).__name__}: {e}"`；都 `raise EmailError(...) from None`
  - `SESV2Client` 只在 `TYPE_CHECKING` 下 import（`mypy_boto3_sesv2`）
  - config 的 `_smtp_needs_fields` 旁加 `ses` 的檢查；`email_sender` 的註解改成「本機預設只印 log；smtp 給其他寄信服務；ses 用 Lambda 的 IAM 權限呼叫 SES API」

- [ ] **Step 4: 執行，確認通過；全部檢查**

Run：`uv run pytest -q`、`uv run ruff check .`、`uv run ruff format --check .`、`uv run mypy`
Expected：全部通過

- [ ] **Step 5: Commit**
```bash
git add backend
git commit -m "feat: 用 SES API 寄信的寄信器"
```

---

### Task 2: Terraform 基礎、ECR、Lambda、SSM

**Files:**
- Create: `infra/terraform/{versions.tf,backend.tf,providers.tf,variables.tf,ecr.tf,lambda.tf,ssm.tf,outputs.tf}`、`infra/terraform/terraform.tfvars.example`
- Create: `infra/terraform/.terraform.lock.hcl`（`terraform init` 產生）
- Modify: `.gitignore`

**Interfaces:**
- Produces（後續 task 引用的 Terraform 位址）：
  - `var.domain`（預設 `"hao007186.com"`）、`var.image_tag`（無預設）、`var.alert_email`、`var.cloudflare_api_token`（sensitive）、`var.cloudflare_zone_id`
  - `local.name = "farewatch"`、`local.ssm_path = "/farewatch/prod/"`、`local.email_from = "FareWatch <noreply@${var.domain}>"`
  - `aws_ecr_repository.backend`（name `farewatch-backend`）
  - `aws_lambda_function.api`（`farewatch-api`）、`aws_lambda_function.jobs`（`farewatch-jobs`）、`aws_lambda_function_url.api`
  - `aws_iam_role.jobs`（Task 3 的 SES 權限掛在這上面）
  - `random_password.origin_verify`（length 48、`special = false`）、`aws_ssm_parameter.origin_verify`（`/farewatch/prod/origin_verify_secret`，SecureString）

- [ ] **Step 1: 寫 Terraform**
  - `versions.tf`：`required_version = ">= 1.10"`；三個 provider 先不寫版本，Step 2 init 後依 lock 檔的版本補上 `~> <major>.0`
  - `backend.tf`：`backend "s3" { key = "prod/terraform.tfstate", region = "ap-southeast-1", use_lockfile = true, encrypt = true }`（bucket 由 `-backend-config="bucket=..."` 傳入）
  - `providers.tf`：預設 aws（ap-southeast-1，`default_tags { tags = { Project = "farewatch" } }`）、`aws.us_east_1`、`cloudflare { api_token = var.cloudflare_api_token }`
  - `ecr.tf`：repository（`image_tag_mutability = "IMMUTABLE"`、`force_delete = false`）＋ lifecycle policy 保留最新 3 個
  - `lambda.tf`：兩個 Lambda 共用 `${aws_ecr_repository.backend.repository_url}:${var.image_tag}`；`architectures = ["arm64"]`；環境變數照 spec（`ENV`、`SSM_PARAMETER_PATH`、`APP_BASE_URL = "https://${var.domain}"`、`EMAIL_SENDER = "ses"`、`EMAIL_FROM = local.email_from`、`LOG_LEVEL = "INFO"`）；jobs 加 `image_config { command = ["app.lambda_handlers.jobs_handler"] }`；兩個 role 都掛 `AWSLambdaBasicExecutionRole` 與自訂 policy（`ssm:GetParametersByPath`、`ssm:GetParameters` 限 `arn:aws:ssm:<region>:<account>:parameter/farewatch/prod*`；`kms:Decrypt` 限 `alias/aws/ssm` 的金鑰，用 `data "aws_kms_alias"`）；兩個 `aws_cloudwatch_log_group`（`/aws/lambda/farewatch-api`、`/aws/lambda/farewatch-jobs`，14 天），Lambda `depends_on` 它們；`aws_lambda_function_url.api`（`authorization_type = "NONE"`）
  - `ssm.tf`：見 Interfaces
  - `outputs.tf`：`ecr_repository_url`、`api_function_url`（之後 Task 3 再補 CloudFront 與 S3 的 output）
  - `terraform.tfvars.example`：列出 `image_tag`、`alert_email`、`cloudflare_api_token`、`cloudflare_zone_id`，值用說明文字
  - `.gitignore` 加：`infra/terraform/.terraform/`、`*.tfstate`、`*.tfstate.*`、`infra/terraform/terraform.tfvars`

- [ ] **Step 2: init 並鎖定 provider 版本**

Run（repo 根目錄，Git Bash）：`MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd)/infra/terraform:/w" -w /w hashicorp/terraform:latest init -backend=false`
Expected：成功，產生 `.terraform.lock.hcl`；依其中的版本把 `versions.tf` 補上 `~> <major>.0`，再 init 一次（`-upgrade=false`）確認一致。Cloudflare provider v5 的 DNS 資源是 `cloudflare_dns_record`（v4 是 `cloudflare_record`），寫法以 init 到的版本文件為準

- [ ] **Step 3: fmt 與 validate**

Run：同一個 docker 指令換成 `fmt -check -recursive`，再換成 `validate`
Expected：fmt 沒有輸出、validate 回 `Success! The configuration is valid.`

- [ ] **Step 4: Commit**
```bash
git add .gitignore infra/terraform
git commit -m "feat: Terraform 建立 ECR、Lambda 與 SSM"
```

---

### Task 3: CloudFront、S3、ACM、DNS、SES

**Files:**
- Create: `infra/terraform/{frontend.tf,dns.tf,ses.tf}`、`infra/terraform/functions/spa-rewrite.js`
- Create: `infra/terraform/functions/spa-rewrite.test.mjs`
- Modify: `infra/terraform/outputs.tf`、`infra/terraform/lambda.tf`（jobs role 加 SES 權限）

**Interfaces:**
- Consumes：Task 2 的 `aws_lambda_function_url.api`、`random_password.origin_verify`、`aws_iam_role.jobs`、`var.domain`、`var.cloudflare_zone_id`
- Produces：`aws_s3_bucket.frontend`、`aws_cloudfront_distribution.site`；outputs `frontend_bucket`、`cloudfront_distribution_id`、`cloudfront_domain`

`spa-rewrite.js`（CloudFront Functions runtime `cloudfront-js-2.0`，只能有頂層 `function handler(event)`，不能用 `export`）：路徑最後一段不含 `.` 時把 `event.request.uri` 改成 `/index.html`，否則原樣回傳。

- [ ] **Step 1: 寫 SPA 改寫的失敗測試** `spa-rewrite.test.mjs`（`node:test`）

讀入 `spa-rewrite.js` 的文字，用 `new Function(code + "\nreturn handler;")()` 取得 `handler`：
```js
// 改寫：  "/" → "/index.html"、"/watches/123" → "/index.html"、"/login" → "/index.html"
//        "/watches/00000000-0000-0000-0000-000000000001/edit" → "/index.html"
// 不改寫："/assets/index-abc123.js"、"/favicon.svg"、"/index.html"
// querystring 不受影響：event.request.querystring 原樣保留
```

- [ ] **Step 2: 執行，確認失敗**

Run：`node --test infra/terraform/functions/`（Node 在 `C:\Program Files\nodejs`，PATH 可能要自己加）
Expected：FAIL（`spa-rewrite.js` 不存在）

- [ ] **Step 3: 寫 `spa-rewrite.js`，跑到通過**

Run：同上
Expected：全部 PASS

- [ ] **Step 4: 寫 Terraform**
  - `frontend.tf`：
    - S3 bucket `farewatch-frontend-<account id>`（`aws_s3_bucket_public_access_block` 全封鎖、版本控制開啟）；`aws_cloudfront_origin_access_control`（s3、sigv4、always）；bucket policy 只允許這個 distribution（`AWS:SourceArn` 條件）
    - `aws_cloudfront_function.spa_rewrite`（`runtime = "cloudfront-js-2.0"`、`code = file("${path.module}/functions/spa-rewrite.js")`、`publish = true`）
    - ACM 憑證（provider `aws.us_east_1`、DNS 驗證）＋ `aws_acm_certificate_validation`（`validation_record_fqdns` 來自 dns.tf 的記錄）
    - distribution：`aliases = [var.domain]`、`default_root_object = "index.html"`、`price_class = "PriceClass_200"`（含亞洲）、`viewer_certificate` 用驗證後的憑證 ARN、`minimum_protocol_version = "TLSv1.2_2021"`、`sni-only`
      - origin `s3`（OAC）；origin `api`：網域取 Function URL 去掉 `https://` 與結尾 `/`，`custom_origin_config` https-only，`custom_header { name = "X-Origin-Verify", value = random_password.origin_verify.result }`
      - default behavior → s3：`redirect-to-https`、GET/HEAD、managed `CachingOptimized`、`function_association { event_type = "viewer-request" }`
      - ordered behavior `/api/*` → api：`redirect-to-https`、全部 7 種 method、managed `CachingDisabled`、managed origin request policy `AllViewerExceptHostHeader`（用 `data "aws_cloudfront_cache_policy"` 與 `data "aws_cloudfront_origin_request_policy"` 依名稱取得）
  - `dns.tf`（Cloudflare，全部 `proxied = false`、`ttl = 1`（自動））：根網域 CNAME → `aws_cloudfront_distribution.site.domain_name`；ACM 驗證記錄（`for_each` 憑證的 `domain_validation_options`）；SES DKIM 3 筆 CNAME（`<token>._domainkey` → `<token>.dkim.amazonses.com`）；`mail` 的 MX（`feedback-smtp.ap-southeast-1.amazonses.com`，priority 10）與 TXT `v=spf1 include:amazonses.com ~all`；`_dmarc` TXT `v=DMARC1; p=none`
  - `ses.tf`：`aws_sesv2_email_identity`（`email_identity = var.domain`，DKIM 預設 Easy DKIM）、`aws_sesv2_email_identity_mail_from_attributes`（`mail.${var.domain}`、`behavior_on_mx_failure = "USE_DEFAULT_VALUE"`）
  - `lambda.tf`：jobs role 加 policy 允許 `ses:SendEmail`，resource 為這個 identity 的 ARN
  - `outputs.tf`：補上 Interfaces 的三個 output

- [ ] **Step 5: fmt 與 validate**（指令同 Task 2）
Expected：fmt 沒有輸出、validate 成功

- [ ] **Step 6: Commit**
```bash
git add infra/terraform
git commit -m "feat: Terraform 建立 CloudFront、S3、DNS 與 SES"
```

---

### Task 4: 排程與告警

**Files:**
- Create: `infra/terraform/{scheduler.tf,monitoring.tf}`

**Interfaces:**
- Consumes：Task 2 的 `aws_lambda_function.jobs`、`aws_lambda_function.api`、`var.alert_email`

- [ ] **Step 1: 寫 Terraform**
  - `scheduler.tf`：一個 scheduler IAM role（trust `scheduler.amazonaws.com`，只能 `lambda:InvokeFunction` jobs）；`locals` 定義 4 筆 `{ name, cron, job }`，用 `for_each` 建 `aws_scheduler_schedule`：
    | name | cron | job |
    |---|---|---|
    | `farewatch-check-prices` | `cron(0 8 * * ? *)` | `check_prices` |
    | `farewatch-resend-1` | `cron(0 9 * * ? *)` | `send_notifications` |
    | `farewatch-resend-2` | `cron(0 11 * * ? *)` | `send_notifications` |
    | `farewatch-maintenance` | `cron(10 0 * * ? *)` | `maintenance` |

    每筆 `schedule_expression_timezone = "Asia/Taipei"`、`flexible_time_window { mode = "OFF" }`、target `input = jsonencode({ job = each.value.job })`、`retry_policy { maximum_retry_attempts = 0 }`（查價重試會重複花額度；jobs 本身已處理重複執行）
  - `monitoring.tf`：
    - `aws_sns_topic.alerts`（`farewatch-alerts`）＋ email 訂閱 `var.alert_email`
    - 告警（全部 `alarm_actions = [sns]`）：`farewatch-jobs-errors`（jobs `Errors` Sum ≥ 1、period 300、`treat_missing_data = "notBreaching"`）、`farewatch-api-errors`（api `Errors` Sum > 5、period 300、notBreaching）、`farewatch-jobs-not-running`（jobs `Invocations` Sum < 1、period 86400、`treat_missing_data = "breaching"`）
    - `aws_budgets_budget`：`farewatch-monthly`、COST、MONTHLY、limit `"1"` USD；notification ACTUAL > 100% 寄 `var.alert_email`

- [ ] **Step 2: fmt、validate，並確認每個 schedule 都有時區**

Run：fmt／validate（同 Task 2）；`grep -c 'schedule_expression_timezone = "Asia/Taipei"' infra/terraform/scheduler.tf`
Expected：fmt 無輸出、validate 成功；grep 結果 ≥ 1，且這一行在 `aws_scheduler_schedule` 的 `for_each` 區塊裡（4 筆共用）

- [ ] **Step 3: Commit**
```bash
git add infra/terraform
git commit -m "feat: Terraform 建立排程、告警與費用預算"
```

---

### Task 5: 部署腳本與文件

**Files:**
- Create: `infra/scripts/push-image.sh`、`infra/scripts/deploy-frontend.sh`
- Create: `docs/deploy-runbook.md`
- Modify: `docs/02-design.md`、`docs/05-deployment.md`、`docs/06-operations.md`、`docs/architecture.md`

**Interfaces:**
- Consumes：Task 2／3 的 outputs `ecr_repository_url`、`frontend_bucket`、`cloudfront_distribution_id`

- [ ] **Step 1: 寫腳本**（都 `#!/usr/bin/env bash`＋`set -euo pipefail`，從 repo 根目錄或任意目錄執行都可以：用 `$(dirname "$0")` 找 repo 根目錄）
  - `push-image.sh <tag>`：tag 必填（沒給就印用法並 exit 1）；`repo=$(terraform -chdir=infra/terraform output -raw ecr_repository_url)`；`aws ecr get-login-password --region ap-southeast-1 | docker login --username AWS --password-stdin "${repo%%/*}"`；`docker buildx build --platform linux/arm64 --provenance=false -t "$repo:$tag" --push backend`；最後印出 image URI
  - `deploy-frontend.sh`：`npm ci`、`npm run build`（在 `frontend/`）→ `aws s3 sync frontend/dist "s3://$bucket" --delete` → `aws cloudfront create-invalidation --distribution-id "$dist" --paths "/*"`
  - 兩者都假設已 `export AWS_PROFILE=farewatch`；本機沒有 terraform 時可改用 `TF_OUTPUT_CMD` 環境變數覆寫取 output 的方式（runbook 說明用 docker 版 terraform 的寫法）

- [ ] **Step 2: shellcheck**

Run：`MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd)/infra/scripts:/mnt" koalaman/shellcheck:stable /mnt/push-image.sh /mnt/deploy-frontend.sh`
Expected：沒有輸出（exit 0）

- [ ] **Step 3: 寫 `docs/deploy-runbook.md`**（照 spec〈一次性手動準備〉〈第一次部署順序〉，每一步附完整指令與「做完應該看到什麼」）；章節：
  1. 會用到的帳號與工具
  2. 一次性手動準備（8 步，含 Identity Center 的點選路徑、state bucket 指令、Neon、Cloudflare token、SSM `put-parameter` 指令四條、`jwt_secret` 用 `python -c "import secrets; print(secrets.token_urlsafe(48))"` 產生、tfvars、SES 驗證信箱與申請解除沙盒）
  3. 第一次部署（7 步）
  4. 驗收清單（spec〈完成標準〉＋ Review Focus 第 4、5 項：重新整理仍維持登入、`aws scheduler get-schedule --name farewatch-check-prices` 顯示 Asia/Taipei）
  5. 之後的更新：換後端（push-image → `terraform apply -var image_tag=...`）、換前端（deploy-frontend）、換機密（`put-parameter --overwrite` 後要等 Lambda 冷啟動，或改一次環境變數強制重啟）、跑 migration
  6. 拆除：`terraform destroy`（ECR 有 image 時要先清空；state bucket 與 Neon 手動刪）

- [ ] **Step 4: 更新其他文件**（照 spec〈文件更新〉）；`architecture.md` 加〈2026-10-26 #7b 決策紀錄〉：SES API、Identity Center、根網域、Cloudflare DNS only、CloudFront Function、排程時間、state 原生鎖

- [ ] **Step 5: 檢查文件裡沒有殘留的 Resend 現況描述**

Run：搜尋 `Resend`（排除 `docs/superpowers/`）
Expected：只剩決策紀錄裡的歷史描述

- [ ] **Step 6: Commit**
```bash
git add infra/scripts docs
git commit -m "docs: 部署手冊與 SES 相關文件更新"
```

---

### 部署前審查（Task 5 之後、Task 6 之前）
- [ ] 在 python:3.14-slim 容器跑一次後端 pytest
- [ ] 整個分支的審查（含 Terraform 安全性：IAM 權限範圍、S3 公開設定、機密是否進 state），Critical／Important 修完才進 Task 6

---

### Task 6: 和使用者一起完成手動準備與第一次部署

這個 task 不寫程式，照 `docs/deploy-runbook.md` 一步一步帶使用者做。**每一個會建立資源、花錢或寫入機密的指令，先說明它會做什麼，等使用者同意再執行**；需要使用者在網頁上操作或輸入機密的步驟，由使用者自己做（機密不經過對話）。

- [ ] **Step 1：** runbook〈一次性手動準備〉1～8，每步做完確認「應該看到什麼」
- [ ] **Step 2：** `terraform init` → `apply -target=aws_ecr_repository.backend`（先給使用者看 plan）
- [ ] **Step 3：** `push-image.sh $(git rev-parse --short HEAD)`
- [ ] **Step 4：** `terraform plan` 給使用者看 → 同意後 `apply`；等 ACM 與 SES 驗證完成（`aws sesv2 get-email-identity --email-identity hao007186.com` 的 `VerifiedForSendingStatus` 為 true）
- [ ] **Step 5：** migration 與兩個 seed（Neon 直連網址）
- [ ] **Step 6：** `deploy-frontend.sh`
- [ ] **Step 7：** 驗收清單逐項打勾；結果記在 PR 說明（由使用者撰寫）可引用的清單裡
- [ ] **Step 8：** 部署中發現 repo 內需要修正的地方（Terraform、腳本、runbook），以 `fix:` 或 `docs:` commit 補上

---

### 收尾
- [ ] Task 6 若有修正 commit，跑一次後端 pytest 與 Terraform fmt／validate
- [ ] push 分支（PR 由使用者自己建立與撰寫）
