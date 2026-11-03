# FareWatch（repo：Project_TicketTrack）

最低價機票即時通知網站，單人維護的展示型作品集。
產品名稱是 **FareWatch**，repo 資料夾名稱是 `Project_TicketTrack`，兩者指同一個專案。

## 目前狀態
- **M1 MVP** 進行中：拆成 7 個子專案，spec／plan 在 `docs/superpowers/`；backend 在 `backend/`，`frontend/` 是前端，`experiments/m0/` 是 M0 的實驗腳本
  - #1～#6、目標價參考價、#7a（Lambda handler）已合併
  - **#7b**（分支 `feat/m1-terraform`）：SES 寄信器、`infra/terraform/`、`infra/scripts/`、`docs/deploy-runbook.md` 已完成並通過部署前審查（PR #12）；手動部署進行中（修正在分支 `fix/m1-deploy`）：AWS 資源（Terraform 46 個）、SSM、SES 網域、Neon migration 與初始資料、前端都已完成，網站已上線；runbook 第 4 節的指令項目與手動查價已通過，**剩確認「歷史紀錄」分頁、申請解除 SES 沙盒**
  - **立即查價**（分支 `feat/instant-price-check`）：建立追蹤或修改條件時立刻查價、表單可查目前價格並用典型低價填目標價，每人每天最多 3 次；spec／plan 在 `docs/superpowers/`；程式已完成並通過審查、已 push，**下一步是使用者開 PR 合併，再部署並線上實測**（部署與實測都要先問）
  - #7c（GitHub Actions 自動部署）尚未開始
- 正式環境：`https://hao007186.com`，AWS ap-southeast-2（帳號只開放雪梨），部署步驟見 `docs/deploy-runbook.md`
- 架構文件是草稿第 3 版：`docs/architecture.md` 是總覽，`docs/01-requirements.md` ~ `docs/06-operations.md` 是 SDLC 6 個階段

## 何時讀哪份文件
- 做需求、架構、設計、實作相關的工作前，先讀 `docs/architecture.md`，再依工作內容讀對應的階段文件
- `docs/skills.md`：可用的 Claude Code skills 一覽

## 規範
- 文件與回覆使用繁體中文
- Commit 格式用 Conventional Commits（`docs:`、`feat:`、`fix:`…）
- 分支策略用 GitHub Flow：從 `main` 開分支，經 PR 合併
