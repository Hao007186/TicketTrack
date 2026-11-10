# FareWatch（repo：Project_TicketTrack）

最低價機票即時通知網站，單人維護的展示型作品集。
產品名稱是 **FareWatch**，repo 資料夾名稱是 `Project_TicketTrack`，兩者指同一個專案。

## 目前狀態
- **M1 MVP** 已完成（2026-11-09）：拆成 7 個子專案，spec／plan 在 `docs/superpowers/`；backend 在 `backend/`，`frontend/` 是前端，`experiments/m0/` 是 M0 的實驗腳本
  - #1～#6、目標價參考價、#7a（Lambda handler）已合併
  - **#7b**（分支 `feat/m1-terraform`）：SES 寄信器、`infra/terraform/`、`infra/scripts/`、`docs/deploy-runbook.md` 已完成並通過部署前審查（PR #12）；手動部署與 runbook 第 4 節驗收已全部完成（修正已合併）：AWS 資源、SSM、SES 網域、Neon migration 與初始資料、前端都已上線；SES 已解除沙盒（2026-11-05），未驗證信箱實寄通過；退信率與投訴率告警已部署（PR #19）
  - **立即查價**：建立追蹤或修改條件時立刻查價、表單可查目前價格並用典型低價填目標價，每人每天最多 3 次；spec／plan 在 `docs/superpowers/`；已合併（PR #15）並部署（`41bc195`），2026-11-05 線上實測通過
  - **改目標價即時判斷**：只改目標價，或這組條件今天已查過時，拿最近 24 小時內的最新價格比目標價，達標就當下通知，不花額度；已合併（PR #16）並部署（`41bc195`），2026-11-05 線上實測通過
  - **#7c**（GitHub Actions 自動部署）：spec／plan 在 `docs/superpowers/`；已上線（PR #21、#22）：main 上的 CI 成功後，`deploy.yml` 比對上次成功部署的 commit，只部署有變更的後端（image、migration、2 個 Lambda）或前端，最後跑冒煙測試；Terraform 仍手動 apply。2026-11-08～09 實測通過：只改前端（PR #23）、只改後端（PR #24）、手動回滾、部署失敗通知（PR #25，停用金鑰後重跑）、只改文件不部署（PR #26）。設定步驟見 `docs/deploy-runbook.md` 第 5 節，回滾見第 6 節
  - **後台**：`/admin` 只有 `role = 'admin'` 能進；可刪除任何人的追蹤、停用（同時刪掉他的追蹤）與恢復帳號，並顯示用量（US-10）。spec／plan 在 `docs/superpowers/`；已合併（PR #27）並自動部署（`237211a`），管理員已照 `docs/deploy-runbook.md` 第 6 節設定；2026-11-10 線上驗收通過（用量、帳號與追蹤列表、刪除追蹤、停用後登出且不能登入、恢復後追蹤不回來）
- 正式環境：`https://hao007186.com`，AWS ap-southeast-2（帳號只開放雪梨），部署步驟見 `docs/deploy-runbook.md`
- 架構文件是草稿第 3 版：`docs/architecture.md` 是總覽，`docs/01-requirements.md` ~ `docs/06-operations.md` 是 SDLC 6 個階段

## 何時讀哪份文件
- 做需求、架構、設計、實作相關的工作前，先讀 `docs/architecture.md`，再依工作內容讀對應的階段文件
- `docs/skills.md`：可用的 Claude Code skills 一覽

## 規範
- 文件與回覆使用繁體中文
- Commit 格式用 Conventional Commits（`docs:`、`feat:`、`fix:`…）
- 分支策略用 GitHub Flow：從 `main` 開分支，經 PR 合併
