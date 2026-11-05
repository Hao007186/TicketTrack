# M1 子專案 #7c：GitHub Actions 自動部署 — 設計

日期：2026-11-05
狀態：待審閱
相關文件：[05-deployment.md](../../05-deployment.md)、[06-operations.md](../../06-operations.md)、[deploy-runbook.md](../../deploy-runbook.md)、[#7b 設計](2026-10-26-m1-terraform-design.md)

## 背景與目標
#7b 已完成正式環境與手動部署，但每次更新都要在本機手動推 image、跑 migration、更新 Lambda、部署前端。

7c 讓 PR 合併進 `main` 後，程式自動部署到正式環境。

**完成標準：**
- 合併只改後端的 PR：自動跑 migration、更新 `farewatch-api` 與 `farewatch-jobs`，前端不動
- 合併只改前端的 PR：自動更新 S3 與 CloudFront，不建新 image
- 合併只改文件的 PR：不部署（除非上一次部署失敗，那次沒上線的變更會一起部署）
- 部署完成後，首頁、`/api/v1/health`、`/api/v1/airports` 都回 200
- PR（含 fork 來的 PR）的執行紀錄拿不到部署機密
- 手動 `terraform plan` 不會想把 Lambda 的 image 改回去
- 用部署金鑰呼叫範圍外的操作（例如 `iam:ListUsers`）被拒絕
- 故意讓一次部署失敗時，GitHub 顯示失敗並寄信通知，線上版本不變

## 不在範圍內
- 自動跑 `terraform apply`、CI 的 `terraform plan`：Terraform 維持手動
- OIDC：帳號的 SCP 目前不允許（見下）
- Neon 分支預演 migration：要多保管 Neon API 金鑰，對單人專案不划算
- 自動回滾：migration 不一定能倒回去，由使用者判斷
- 部署前人工核准、測試環境：合併就是上線的確認點
- 自動跑 seed：初始資料維持手動

## 設計決定
| 項目 | 決定 | 理由 |
|---|---|---|
| AWS 認證 | 專用 IAM 使用者 `farewatch-deploy`＋存取金鑰 | 2026-11-05 查證：SCP `p-wtjmoxgq` 明確拒絕 `iam:CreateOpenIDConnectProvider`，OIDC 不能用；帳號升級付費方案後再評估 |
| 金鑰放哪個帳號 | 不用 `farewatch-admin` | 它有管理員權限，外洩時整個帳號都有風險 |
| Terraform | 不在自動部署裡執行 | 要跑 Terraform，金鑰幾乎等於管理員，Cloudflare token 也要放進 GitHub |
| Migration | 部署流程直接跑，直連網址放 GitHub Secrets | 部署金鑰已能透過更新 Lambda 間接碰到資料庫，多這個機密增加的風險不大；讓 Lambda 跑要多寫程式和權限 |
| 部署時機 | 合併後全自動，沒有人工核准 | 合併前已有 CI 和使用者確認 |
| 觸發方式 | `workflow_run`：等 `main` 上的 CI 成功才部署 | PR 通過不代表合併後的結果也沒問題；不必重跑一次測試 |
| 部署範圍 | 依變更路徑分開部署後端與前端 | ECR 只保留 3 個 image，只改前端時建新 image 會擠掉能回滾的舊版 |
| 建 image 的機器 | GitHub 的 arm64 runner（`ubuntu-24.04-arm`） | Lambda 是 arm64，不用模擬，比較快；公開 repo 可免費使用 |
| 冒煙測試 | 首頁、`/api/v1/health`、`/api/v1/airports` | `/health` 刻意不查資料庫，要靠 `/airports` 才會發現資料庫連不上 |
| 通知 | GitHub 內建的失敗通知信 | 不用多建東西；要確認使用者的 GitHub 通知設定有開 |

## 部署流程
新增 `.github/workflows/deploy.yml`：

```text
main 上的 CI 成功（workflow_run）
  └─ 判斷變更（這次 commit 和「上一次部署成功的 commit」比較）
       ├─ backend/** 有變更 → backend job
       │    建 arm64 image → 推 ECR（tag 是 git short SHA；已存在就跳過）
       │    → alembic upgrade head → 更新 2 個 Lambda 並等待更新完成
       ├─ frontend/** 有變更 → frontend job（等 backend job 結束，失敗就不跑）
       │    build → 上傳 S3 → 清 CloudFront 快取
       └─ 有部署任何東西 → smoke job
            首頁、/api/v1/health、/api/v1/airports 都要回 200（失敗時重試幾次）
```

- `.github/workflows/deploy.yml` 本身有變更但程式沒變時，不部署
- **比較對象是上一次部署成功的 commit**，不是前一個 commit。否則部署失敗後，下一個只改文件的 PR 會讓沒上線的變更被漏掉；GitHub 的排隊也只保留最新一個等待中的部署，連續合併時中間那次會被取消。沒有成功紀錄時（第一次）全部部署；這次的 commit 比上次成功的還舊時不部署
- 成功部署的 commit 記在執行名稱（`run-name`），因為 `workflow_run` 執行紀錄上的 commit 是觸發當下的 `main`，不一定是實際部署的那個
- backend job 因為沒有後端變更而跳過時，frontend job 仍要執行；只有 backend job 失敗才不跑
- **排隊**：`concurrency` 讓部署一次跑一個，後來的等待，不取消進行中的部署（中途取消可能留下做一半的 migration）
- **image 重複**：ECR 的 tag 不能覆蓋，所以重跑同一個 commit 時要先檢查 tag，已存在就跳過推送，才能重跑失敗的部署
- **重用腳本**：沿用 `infra/scripts/push-image.sh`、`deploy-frontend.sh`（已支援用環境變數指定目標）
- **更新 Lambda 的新腳本**：`infra/scripts/deploy-lambdas.sh <tag>`，用 `aws lambda update-function-code` 更新並用 `aws lambda wait function-updated` 等待。自動部署和手動回滾都用它
- **Migration 的環境變數**：`DATABASE_URL` 用機密；`Settings` 還要求 `JWT_SECRET`，migration 用不到，給一個明顯是假的值

## 錯誤處理
任何一步失敗，後面的步驟都不執行。

| 失敗的時間點 | 線上狀態 | 處理 |
|---|---|---|
| 建 image、推 ECR | 沒變 | 修好後合併，或重跑 |
| Migration | 舊程式繼續跑；migration 向後相容，所以舊程式不受影響 | 看 GitHub 上的錯誤 |
| 更新 Lambda（第 2 個才失敗） | `api` 是新版，`jobs` 是舊版 | 重跑部署，或回滾 |
| 前端 | 後端已是新版，前端是舊版 | 重跑部署；API 要向後相容 |
| 冒煙測試 | 新版已上線 | 使用者決定是否回滾 |

**回滾後端**：`infra/scripts/deploy-lambdas.sh <上一版的 tag>`（ECR 保留最新 3 個）。Terraform 不再管 image，所以不能再用 `terraform apply -var image_tag=...` 回滾。

**限制**：這裡的回滾只換程式，不會倒回 migration。

## 權限與機密
### `farewatch-deploy`（新增 `infra/terraform/deploy_user.tf`）
由 Terraform 建立使用者與權限；存取金鑰由使用者在 AWS 主控台手動建立，**不**用 Terraform 建，否則金鑰會存進 state。

| 用途 | 權限 | 範圍 |
|---|---|---|
| 登入 ECR | `ecr:GetAuthorizationToken` | `*`（AWS 規定） |
| 推 image、讓 Lambda 取用 | ECR 的推送與讀取動作 | 只限 `farewatch-backend` |
| 更新 Lambda | `lambda:UpdateFunctionCode`、`lambda:GetFunction`、`lambda:GetFunctionConfiguration` | 只限 2 個 Lambda |
| 上傳前端 | `s3:PutObject`、`s3:ListBucket` | 只限前端 bucket |
| 清快取 | `cloudfront:CreateInvalidation` | 只限這個 distribution |

**已知的風險（不隱藏）**：金鑰不能直接讀 SSM，但能部署任意程式到 Lambda，而 Lambda 的角色讀得到機密。所以金鑰外洩時，機密和資料庫仍有風險；它防的是對方直接動 IAM、建新資源或開高價服務。外洩時的處理：停用金鑰，並更換 SSM 機密和 Neon 密碼。

### GitHub
- 機密放在 `production` Environment，部署分支限定 `main`：`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、`DATABASE_URL`
- 不是機密的設定（ECR 網址、bucket、distribution ID）放 Environment variables
- `ci.yml` 不接觸這個 Environment，所以 PR 拿不到機密
- 部署流程用的第三方 Action 鎖定到 commit SHA；`permissions` 只給 `contents: read` 和 `actions: read`（查上一次成功的部署）
- `workflow_run` 只接受來自本 repo、`push` 事件、分支 `main` 且成功的 CI，避免 fork 把分支取名 `main` 來觸發部署
- repo 是公開的：不要在 log 印出機密；`DATABASE_URL` 只放在 migration 這一步的環境變數

## Terraform 調整
- 兩個 Lambda 加 `lifecycle { ignore_changes = [image_uri] }`，之後手動 `terraform apply` 不會把 image 蓋回去
- `image_tag` 變成只有建立資源時才用得到，給預設值 `bootstrap`，平常不用再傳 `-var image_tag`。**注意**：從零重建時仍要傳真的 tag，runbook 第 3 節維持現在的寫法
- 手動 apply 內容：新增 `farewatch-deploy` 使用者與權限，Lambda 不更動（要先看 plan 確認，並先問使用者）

## 文件
- `docs/05-deployment.md`：CI/CD 改成實際流程；移除 Neon 預演與 Terraform apply；記下不用 OIDC 的原因；更新回滾策略
- `docs/deploy-runbook.md`：新增「設定自動部署」一節（建金鑰、設定 GitHub Environment）；第 5 節改成自動部署為主、手動腳本為備用；回滾改用 `deploy-lambdas.sh`；新增金鑰外洩的處理
- `docs/06-operations.md`：加上部署失敗與金鑰外洩的處理
- `docs/architecture.md`：新增決策紀錄
- `CLAUDE.md`：更新進度

## 測試與驗收
工作流程沒辦法完全在本機測試，所以分三層：

1. **本機與 PR 檢查**：`terraform fmt`、`validate`、`plan`；對 YAML 跑 `actionlint`；對 shell 腳本跑 `shellcheck`
2. **權限驗證**：用部署金鑰確認範圍內的操作可以、範圍外的被拒絕
3. **線上實測**（每次都會更新正式環境，要先問使用者）：
   - 只改前端的小 PR：確認不建 image、畫面更新
   - 只改後端的小 PR：確認 image 更新、2 個 Lambda 都換版、冒煙測試通過
   - 只改文件的 PR：確認不部署
   - 手動回滾一次再部署回來，確認 runbook 正確
   - 失敗通知：暫時停用部署金鑰，重跑一次部署，讓它在登入 ECR 時失敗（線上不受影響），確認收到信後恢復金鑰

上線順序：合併 Terraform 調整 → 手動 apply → 使用者建立金鑰和 GitHub Environment → 合併工作流程 → 線上實測。
