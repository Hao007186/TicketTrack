# 階段 5：部署（Deployment）

[← 回總覽](architecture.md)｜上一階段：[測試](04-testing.md)｜下一階段：[維運](06-operations.md)

## 環境
| 環境 | 內容 |
|---|---|
| local | docker-compose（Postgres、api）、mock provider、console 寄信器（信印在 log） |
| k8s-demo | kind + Helm（本機和 CI，M3） |
| prod | AWS Serverless + Neon + Cloudflare DNS |

（單人專案不另外建 staging；合併進 `main` 就是上線的確認點）

## 一次性手動設定（寫進部署文件）
完整步驟與指令見 [部署手冊](deploy-runbook.md)。
- 購買網域（`hao007186.com`），將 DNS 交給 Cloudflare 管理；建立只能編輯這個網域 DNS 的 API token
- 本機用 IAM 使用者 `farewatch-admin` 的**存取金鑰**登入 AWS（Free plan 帳號不能開 IAM Identity Center），不用 root
- 所有 AWS 資源放 **ap-southeast-2（雪梨）**：帳號的 SCP 只開放這個區域（CloudFront 憑證照規定放 us-east-1）
- 建立 Neon 專案（雪梨區），把連線字串、JWT 密鑰、SerpApi key 用 AWS CLI 放進 SSM（不經過 Terraform）
- SES：網域驗證與 DNS 記錄由 Terraform 建立；手動驗證自己的信箱供沙盒期間測試，並申請解除沙盒
- 建立 LINE Provider，並在其下建立 Login channel 和 Messaging API channel
- 建立 Terraform state 用的 S3 bucket（避免雞生蛋問題，不由 Terraform 自己建立）

## CI/CD
- `ci.yml`（PR 與 main）：lint + 型別檢查 + 單元／整合測試 + 前端 build + docker build + 部署腳本的 shellcheck 與測試
- `k8s-e2e.yml`（PR，M3）：建 amd64 image 並 `kind load`（不推 ECR）→ `helm install` → 冒煙測試 + Playwright E2E
- `deploy.yml`（`workflow_run`：`main` 上的 CI 成功後）：和**上一次部署成功的 commit** 比較，依變更路徑分開部署
  - `backend/` 有變更：在 arm64 runner 建單一架構 image（`--provenance=false`）推上 ECR（tag = commit 前 7 碼，已存在就跳過）→ `alembic upgrade head` → `deploy-lambdas.sh` 更新 2 個 Lambda 並等待完成
  - `frontend/` 有變更：build → `s3 sync` → CloudFront invalidation（後端部署失敗時不跑）
  - 有部署任何東西：冒煙測試首頁、`/api/v1/health`、`/api/v1/airports`
  - 比較上一次成功的部署而不是前一個 commit：部署失敗後，下一個只改文件的 PR 仍會補上沒上線的變更；這次的 commit 比上次成功的還舊時不部署，避免連續合併時蓋回舊版
  - 一次只跑一個部署，不取消進行中的部署（避免 migration 做一半）
  - 只接受本 repo 的 `main` 被 push 且 CI 成功；fork 把分支取名 `main` 送 PR 不會觸發
- **Terraform 不在自動部署裡**：維持手動 `plan`／`apply`。要跑 Terraform，金鑰幾乎等於管理員，Cloudflare token 也要放進 GitHub。Lambda 的 `image_uri` 設成 `ignore_changes`，手動 apply 不會把 image 蓋回舊版
- **AWS 認證用專用 IAM 使用者 `farewatch-deploy` 的存取金鑰**，放在 GitHub Environment `production`（只限 `main`）。原本規劃 GitHub OIDC，但帳號的 SCP 明確拒絕 `iam:CreateOpenIDConnectProvider`；帳號升級付費方案後再評估。權限只夠推 image、更新 2 個 Lambda、上傳前端、清快取。已知風險：金鑰能部署任意程式到 Lambda，而 Lambda 讀得到機密，外洩時機密也要更換（見[部署手冊](deploy-runbook.md#5-設定自動部署)）
- 不做：Neon 分支預演 migration（要多保管 Neon API 金鑰）、自動回滾（migration 不一定能倒回去）、部署前人工核准

## 回滾策略
- 程式：`infra/scripts/deploy-lambdas.sh <上一版的 tag>`（ECR 保留 3 個版本）；只換程式，不會倒回 migration。由人判斷要不要回滾，不自動回滾
- 資料庫：migration 一律向後相容（先加欄位、再改程式、最後才刪欄位）；資料救援以每週 `pg_dump` 備份為主，Neon 免費版的 point-in-time restore 視窗很短（實作時確認當時的額度），只能救剛發生的誤操作
- 前端：S3 開啟版本控制，可以還原上一版

## 成本控管
- **網域**：約 US$10／年（唯一固定支出）
- **AWS 免費方案期間**（新帳號最多 6 個月）：費用由抵用金支付，信用卡不會被扣款。**到期或抵用金用完之前必須升級成付費方案，否則帳號會被關閉**
- **之後**：ECR、S3 每月幾分錢，其他都在永久免費額度內；SES 每 1,000 封約 US$0.10，量少幾乎是 0

| 會產生費用的項目 | 怎麼避免 |
|---|---|
| API Gateway（免費額度只有 12 個月） | 改用 Lambda Function URL |
| Route 53 hosted zone（每月 US$0.50） | DNS 放 Cloudflare |
| ECR 儲存費 | lifecycle 規則只保留 3 個 image |
| Secrets Manager | 改用 SSM Parameter Store 標準版 |
| CloudWatch Logs 超過 5GB | log 只保留 7–14 天 |
| NAT Gateway | Lambda 不放進 VPC |
| KMS 自訂金鑰 | 使用 AWS 管理的金鑰 |
| SerpApi 超量 | 硬上限 250 次，用完就暫停查價，不升級付費 |
| 忘記關掉的資源 | AWS Budgets US$1 告警 + 全部用 Terraform 管理 |
| 免費方案到期，帳號被關閉 | 到期前升級成付費方案（設行事曆提醒），升級後靠 Budgets US$1 告警把關 |

