# #7c GitHub Actions 自動部署 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal：** PR 合併進 `main` 且 CI 通過後，後端與前端依變更自動部署到正式環境。

**Architecture：** `deploy.yml` 用 `workflow_run` 接在 `main` 的 CI 之後。判斷變更與更新 Lambda 放進 bash 腳本，可以在本機測試，手動回滾也共用。Terraform 維持手動，只負責建立 `farewatch-deploy` 使用者與不再管 Lambda 的 image。

**Tech Stack：** GitHub Actions、bash、Terraform、AWS CLI、uv、Alembic、Node 24。

**Spec：** [docs/superpowers/specs/2026-11-05-m1-auto-deploy-design.md](../specs/2026-11-05-m1-auto-deploy-design.md)

## Global Constraints
- 區域 `ap-southeast-2`；Lambda `farewatch-api`、`farewatch-jobs`；ECR `farewatch-backend`；IAM 使用者 `farewatch-deploy`
- image tag 是 commit 的前 7 碼；ECR tag 不可覆蓋、只保留最新 3 個
- GitHub Environment 名稱 `production`，部署分支只限 `main`；secrets：`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、`DATABASE_URL`（Neon 直連）；variables：`ECR_REPO`、`FRONTEND_BUCKET`、`CLOUDFRONT_DISTRIBUTION_ID`
- 只有部署用的 job 宣告 `environment: production`；`ci.yml` 不宣告
- 第三方 Action 鎖定 commit SHA（用 `git ls-remote <repo> 'refs/tags/<版本>^{}'` 取得解開後的 commit，註解標版本）
- 腳本用 LF 換行並標記可執行（`git update-index --chmod=+x`）
- 本機工具用 Docker：`koalaman/shellcheck:stable`、`rhysd/actionlint:latest`；Git Bash 掛載路徑要加 `MSYS_NO_PATHCONV=1`
- **`terraform apply`、建金鑰、合併後的實際部署都要先問使用者**；機密由使用者自己輸入，不經過 Claude
- 文件、註解用繁體中文；Conventional Commits，結尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Review Focus
1. Fork 把分支取名 `main` 送 PR：不能觸發部署 → Task 3 的 `if` 檢查 `event`、`head_branch`、`head_repository`，並用 grep 驗證
2. 部署失敗後，下一個 PR 只改文件：沒上線的後端變更仍要部署 → Task 1 的測試
3. 連續合併，較舊的 CI 較晚結束：不能把線上蓋回舊版 → Task 1 的測試（比上次成功舊就不部署）
4. 重跑同一個 commit：ECR 的 tag 已存在時不能失敗 → Task 2 的測試
5. 手動 `terraform apply` 把 Lambda 蓋回舊 image → Task 4 的 plan 必須顯示 Lambda 沒有變更

---

### Task 1: 判斷部署範圍

**Files:**
- Create: `infra/scripts/deploy-scope.sh`
- Test: `infra/scripts/tests/test-deploy-scope.sh`
- Modify: `.github/workflows/ci.yml`（新增 `deploy-scripts` job，跑這個測試）

**Interfaces:**
- Produces：`deploy-scope.sh <base_sha 或空字串> <head_sha>`，在 stdout 輸出兩行 `backend=true|false`、`frontend=true|false`，可直接接到 `$GITHUB_OUTPUT`。路徑規則：`backend/` 開頭算後端、`frontend/` 開頭算前端

- [ ] **Step 1: 寫失敗的測試**：在暫存 git repo 建立 commit，逐一斷言：

| 情境 | 預期 |
|---|---|
| base 是空字串 | `true`／`true` |
| base 在本機找不到 | `true`／`true` |
| base 與 head 相同 | `false`／`false` |
| 只改 `backend/x` | `true`／`false` |
| 只改 `frontend/x` | `false`／`true` |
| 只改 `docs/x` | `false`／`false` |
| base 到 head 之間有後端變更，最新 commit 只改文件 | `true`／`false` |
| head 比 base 舊 | `false`／`false` |
| 分岔歷史（base 不是 head 的祖先，head 也不是 base 的祖先） | `true`／`true` |

- [ ] **Step 2: 執行確認失敗**

Run: `bash infra/scripts/tests/test-deploy-scope.sh`
Expected: 失敗，訊息是找不到 `deploy-scope.sh`

- [ ] **Step 3: 實作 `deploy-scope.sh`**：用 `git cat-file -e`、`git merge-base --is-ancestor`、`git diff --name-only base head`

- [ ] **Step 4: 執行確認通過，並跑 shellcheck**

Expected: 所有情境 PASS、shellcheck 沒有輸出

- [ ] **Step 5: 在 `ci.yml` 新增 `deploy-scripts` job 並 commit**

```bash
git commit -m "feat: 新增判斷部署範圍的腳本與測試"
```

### Task 2: 更新 Lambda 與可重跑的推 image

**Files:**
- Create: `infra/scripts/deploy-lambdas.sh`
- Modify: `infra/scripts/push-image.sh`
- Test: `infra/scripts/tests/test-deploy-lambdas.sh`（用放在 `PATH` 最前面的假 `aws`、`docker`、`terraform` 記錄呼叫）

**Interfaces:**
- Produces：
  - `deploy-lambdas.sh <tag>`：`ECR_REPO` 沒設時從 Terraform output 讀；依序更新 `farewatch-api`、`farewatch-jobs`，每個都 `aws lambda wait function-updated`，全部完成後比對 `ImageUri` 確實是 `<repo>:<tag>`
  - `push-image.sh <tag>`：tag 已存在於 ECR 時印出訊息並以 0 結束，不建 image

- [ ] **Step 1: 寫失敗的測試**
  - `test_updates_both_functions_and_waits`：假 `aws` 紀錄依序含兩個函式的 `update-function-code` 和 `wait function-updated`
  - `test_stops_when_first_update_fails`：第一個失敗時，非 0 結束且沒有呼叫第二個
  - `test_fails_when_image_uri_mismatch`：更新後 `ImageUri` 不符時非 0 結束
  - `test_requires_tag`：沒有參數時非 0 結束
  - `test_push_skips_existing_tag`：`describe-images` 成功時不呼叫 `docker buildx`，以 0 結束
  - `test_push_builds_when_tag_missing`：`describe-images` 回 `ImageNotFoundException` 時呼叫 `docker buildx`
  - `test_push_fails_on_other_errors`：`describe-images` 回其他錯誤（例如權限不足）時非 0 結束，不當成 tag 不存在

- [ ] **Step 2: 執行確認失敗**

Run: `bash infra/scripts/tests/test-deploy-lambdas.sh`
Expected: 失敗

- [ ] **Step 3: 實作兩個腳本**

- [ ] **Step 4: 執行確認通過，並跑 shellcheck**

- [ ] **Step 5: `ci.yml` 的 `deploy-scripts` job 也跑這個測試，然後 commit**

```bash
git commit -m "feat: 新增更新 Lambda 的腳本，推 image 可重跑"
```

### Task 3: 部署工作流程

**Files:**
- Create: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes：Task 1、2 的腳本；`deploy-frontend.sh`（讀 `FRONTEND_BUCKET`、`CLOUDFRONT_DISTRIBUTION_ID`）

- [ ] **Step 1: 寫 `deploy.yml`**，固定以下內容：
  - `on.workflow_run`：`workflows: [CI]`、`types: [completed]`、`branches: [main]`
  - `run-name: Deploy ${{ github.event.workflow_run.head_sha }}`
  - `concurrency: { group: deploy-production, cancel-in-progress: false }`
  - `permissions: { contents: read, actions: read }`
  - 每個 job 的 checkout 都用 `ref: ${{ github.event.workflow_run.head_sha }}`
  - `scope` job（不宣告 Environment）：`if` 同時要求 `conclusion == 'success'`、`event == 'push'`、`head_branch == 'main'`、`head_repository.full_name == github.repository`。`fetch-depth: 0`。用 `gh run list --workflow deploy.yml --branch main --status success --limit 1 --json displayTitle` 取上次成功的 commit（`gh` 失敗時整個 job 失敗，不能當成沒有紀錄），再呼叫 `deploy-scope.sh`
  - `backend` job：`ubuntu-24.04-arm`、`environment: production`。設定 AWS 憑證 → `push-image.sh <tag>` → `uv sync --locked` 後在 `backend/` 跑 `uv run python -m alembic upgrade head`（只有這一步有 `DATABASE_URL`；`ENV=ci`、`JWT_SECRET=not-used-by-migrations`）→ `deploy-lambdas.sh <tag>`
  - `frontend` job：`needs: [scope, backend]`，`if` 要求 `!cancelled()`、`needs.scope.outputs.frontend == 'true'`、`needs.scope.result == 'success'`、`needs.backend.result` 不是 `failure`。Node 24 → `deploy-frontend.sh`
  - `smoke` job：`if` 要求 `!cancelled()`、前面沒有失敗、至少部署了一項。對 `https://hao007186.com/`、`/api/v1/health`、`/api/v1/airports` 跑 `curl -fsS -o /dev/null --retry 5 --retry-all-errors --retry-delay 5`

- [ ] **Step 2: 用 actionlint 檢查**

Expected: 沒有輸出

- [ ] **Step 3: 驗證安全條件**

Run: `grep -nE "head_repository|head_branch|conclusion|event ==" .github/workflows/deploy.yml`；`grep -n "environment:" .github/workflows/ci.yml`
Expected: 第一個四項都有；第二個沒有結果

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: 新增合併後自動部署的工作流程"
```

### Task 4: Terraform 調整

**Files:**
- Create: `infra/terraform/deploy_user.tf`
- Modify: `infra/terraform/lambda.tf`、`infra/terraform/variables.tf`、`infra/terraform/outputs.tf`

**Interfaces:**
- Produces：output `deploy_user_name`；既有的 `ecr_repository_url`、`frontend_bucket`、`cloudfront_distribution_id` 是 GitHub variables 的來源

- [ ] **Step 1: 修改 Terraform**
  - 兩個 Lambda 加 `lifecycle { ignore_changes = [image_uri] }`
  - `image_tag` 加 `default = "bootstrap"`，說明只有從零建立時要傳真的 tag
  - `deploy_user.tf`：建立 `aws_iam_user` 和 `aws_iam_user_policy`，權限照 spec〈權限與機密〉的表。ECR 另加 `ecr:DescribeImages`（`push-image.sh` 用）。**不建** access key

- [ ] **Step 2: 驗證**

Run: `terraform fmt -check`、`terraform validate`、`terraform plan -input=false -no-color`（`AWS_PROFILE=farewatch`）
Expected: `Plan: 2 to add, 0 to change, 0 to destroy.`，只有使用者和政策，**Lambda 沒有變更**

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: 新增部署用 IAM 使用者，Terraform 不再管 Lambda 的 image"
```

### Task 5: 文件

**Files:**
- Modify: `docs/05-deployment.md`、`docs/06-operations.md`、`docs/deploy-runbook.md`、`docs/architecture.md`、`CLAUDE.md`

- [ ] **Step 1: 照 spec〈文件〉一節更新**。`deploy-runbook.md` 新增的「設定自動部署」要有完整步驟：
  - 建金鑰（用途選 Third-party service 或 Application running outside AWS）
  - 建 Environment `production`、限定 `main`、填 3 個 secrets 和 3 個 variables
  - 金鑰外洩的處理：停用金鑰、更換 SSM 機密和 Neon 密碼
  - 第一次自動部署沒有成功紀錄，後端和前端都會部署一次

- [ ] **Step 2: 確認沒有留下舊做法**

Run: `grep -n "apply -var image_tag" docs/deploy-runbook.md docs/05-deployment.md`
Expected: 只剩從零重建的第 3 節

- [ ] **Step 3: Commit**

```bash
git commit -m "docs: 更新自動部署的流程、回滾與金鑰處理"
```

### Task 6: 上線與實測（和使用者一起做，每一步先問）

- [ ] **Step 1: 全部測試通過後 push，使用者開 PR 並合併**。此時還沒有 Environment，第一次部署會因為缺少機密而失敗，線上不受影響。**因此先把 `deploy.yml` 留在最後一個 PR**：先合併 Task 1、2、4、5，Task 3 另開 PR
- [ ] **Step 2: 手動 apply**：plan 必須仍是 2 to add、0 to change，使用者同意後執行
- [ ] **Step 3: 使用者建立金鑰與 Environment**，機密由使用者自己填
- [ ] **Step 4: 權限驗證**（使用者用部署金鑰執行）：`aws lambda update-function-code --dry-run --function-name farewatch-api --image-uri <目前的 image>` 成功；`aws iam list-users` 被拒絕。dry-run 被拒就補權限，回到 Step 2
- [ ] **Step 5: 合併 `deploy.yml` 的 PR**：這是第一次自動部署（CI 改動不算程式變更，但沒有成功紀錄，所以全部部署）
  - Expected：3 個 job 都通過；2 個 Lambda 的 image 是新 tag；網站正常；確認 `alembic upgrade head` 的 log 沒有印出連線字串
- [ ] **Step 6: 依 spec〈測試與驗收〉實測**：只改前端、只改後端、只改文件、手動回滾再部署回來、失敗通知。Expected 都照 spec
- [ ] **Step 7: 更新 `CLAUDE.md` 和進度**，#7c 完成
