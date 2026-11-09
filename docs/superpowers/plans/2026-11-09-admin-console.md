# 後台（管理帳號、追蹤與用量）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** admin 可以在 `/admin` 看到用量、帳號與佔名額的追蹤，並刪除追蹤、停用與恢復帳號。

**Architecture:** 後端新增 `app/modules/admin/`（router、schemas、service、usage），所有端點掛在 `/api/v1/admin` 並經過新的 `require_admin`。刪除追蹤沿用 watches 的鎖與補位流程，抽出共用函式。前端新增 `AdminPage`，資料用 TanStack Query 抓取，型別由 `openapi.json` 產生。

**Tech Stack:** FastAPI、SQLAlchemy 2（async）、pytest；React 19、TanStack Query、openapi-fetch、Vitest + MSW。

**Spec:** `docs/superpowers/specs/2026-11-09-admin-console-design.md`

## Global Constraints
- 不新增 migration、不改資料表；不新增任何套件
- 畫面文字、錯誤訊息、文件一律繁體中文；Commit 用 Conventional Commits，結尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- API 對外只用 `public_id`，不露出流水號 id
- 「今天」「本月」一律台灣時間：`app.core.clock.get_today`、`prices.checker.today_start`、`prices.checker.usage_month`
- 錯誤碼：未登入 401、非 admin 403、找不到 404、規則不允許 409
- 後端測試要先開測試資料庫（見下方），`TEST_DATABASE_URL` 一定寫 `127.0.0.1`
- 每個 task 結束前在 `backend/` 跑 `uv run ruff check && uv run ruff format --check && uv run mypy`，前端跑 `npm run lint && npm run typecheck`

測試資料庫（Docker Desktop 要先開）：
```bash
MSYS_NO_PATHCONV=1 docker run -d --rm --name farewatch-test-db -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=farewatch_test -p 127.0.0.1:55432:5432 --tmpfs /var/lib/postgresql/data postgres:16
export TEST_DATABASE_URL=postgresql+psycopg://test:test@127.0.0.1:55432/farewatch_test
```

## Review Focus
1. **停用的人跟別人共用同一組條件**：他的追蹤刪掉後，別人那個追蹤仍是 active，名額不會被誤判為空出（Task 2 `test_deactivate_keeps_shared_query_occupied`）
2. **停用後他手上的 access token 立刻失效**：下一個請求回 401，不必等 token 過期（Task 2 `test_deactivated_token_rejected`）
3. **SerpApi 逾時或故障**：`/admin/usage` 仍回 200，三個依賴剩餘額度的欄位是 `null`，畫面其他數字照常顯示（Task 4 `test_usage_provider_failure`、Task 5 `顯示查詢失敗`）
4. **月初的台灣時間邊界**：UTC 10/31 17:00（台灣 11/01 01:00）建立的寄信紀錄算 11 月（Task 4 `test_usage_email_month_taipei`）
5. **admin 在後台刪掉自己的追蹤**：「我的追蹤」列表也要更新，不能還顯示已刪的追蹤（Task 5 mutation 同時讓 `keys.watches` 失效）

---

### Task 1: `require_admin` 與帳號列表

**Files:**
- Modify: `backend/app/modules/auth/deps.py`（加 `require_admin`、`AdminUser`）
- Create: `backend/app/modules/admin/__init__.py`、`router.py`、`schemas.py`、`service.py`
- Modify: `backend/app/main.py`（`include_router(admin_router.router, prefix=f"{API_PREFIX}/admin")`）
- Modify: `backend/tests/conftest.py`（`create_user` 加參數 `role: str = "user"`）
- Create: `backend/tests/admin/__init__.py`、`conftest.py`、`test_users.py`

**Interfaces:**
- Produces:
  - `auth.deps.require_admin(user: CurrentUser) -> User`；`role != "admin"` 時 `HTTPException(403, "需要管理員權限")`
  - `auth.deps.AdminUser = Annotated[User, Depends(require_admin)]`
  - `admin.schemas.AdminUserOut`：`public_id: uuid.UUID`、`email: str`、`display_name: str | None`、`role: str`、`is_demo: bool`、`is_active: bool`、`created_at: datetime`、`slot_count: int`
  - `admin.service.list_users(session) -> list[AdminUserOut]`，依 `created_at` 新到舊（相同時再依 id 新到舊）；`slot_count` = 該使用者狀態為 `active` 或 `queued` 的追蹤數（一次查詢用 LEFT JOIN + GROUP BY，不要每人查一次）
  - router：`GET /users -> list[AdminUserOut]`
  - `tests/admin/conftest.py`：重新匯出 `tests.watches.conftest` 的 `TODAY`、`reference`、`fixed_today`、`auth_headers`、`demo_headers`、`insert_watch`、`fill_slots`、`conditions`（比照 `tests/prices/conftest.py`），並新增 `async def admin_headers(client, session, email="admin@example.com") -> dict[str, str]`（`create_user(..., role="admin")` 後登入）

- [ ] **Step 1: 寫失敗的測試** `tests/admin/test_users.py`
  - `test_requires_login`：不帶 token `GET /api/v1/admin/users` → 401
  - `test_user_forbidden`、`test_demo_forbidden`：一般帳號、示範帳號 → 403，`detail == "需要管理員權限"`
  - `test_list_users`：admin + alice（1 個 active、1 個 queued、1 個 paused 追蹤）+ 停用的 bob → 回 3 筆，新到舊；alice 的 `slot_count == 2`；bob 的 `is_active is False`；每筆有 `public_id` 且沒有 `id` 欄位
- [ ] **Step 2: 跑測試確認失敗** `uv run pytest tests/admin -v` → 404（路由不存在）
- [ ] **Step 3: 實作** 上列 Interfaces
- [ ] **Step 4: 跑測試確認通過** `uv run pytest tests/admin tests/test_entrypoints.py -v` → PASS
- [ ] **Step 5: Commit** `feat: 後台 API 加上管理員權限與帳號列表`

### Task 2: 停用與恢復帳號

**Files:**
- Modify: `backend/app/modules/admin/service.py`、`router.py`
- Create: `backend/tests/admin/test_deactivate.py`

**Interfaces:**
- Consumes: Task 1 的 `AdminUser`、`AdminUserOut`；`watches.slots.acquire_watch_lock`、`watches.slots.rebalance(session, today)`；`auth.models.RefreshToken`
- Produces:
  - 例外：`UserNotFound`、`CannotDeactivate(message: str)`、`AlreadyInState(message: str)`，router 轉成 404「找不到帳號」／409（訊息照例外內容）
  - `deactivate_user(session, admin: User, public_id: uuid.UUID, today: date) -> AdminUserOut`
  - `reactivate_user(session, public_id: uuid.UUID) -> AdminUserOut`
  - router：`POST /users/{public_id}/deactivate`、`POST /users/{public_id}/reactivate`，用 `TodayDep`（`app.core.clock.get_today`）

停用的順序（同一個 transaction）：`acquire_watch_lock` → 檢查 → `is_active = False` → `DELETE watches WHERE user_id = 目標` → `DELETE refresh_tokens WHERE user_id = 目標` → `flush` → `rebalance` → `commit`。

409 訊息（照寫）：
- 目標是自己：「不能停用自己的帳號」
- 目標是示範帳號：「不能停用示範帳號」
- 目標是其他 admin：「不能停用管理員帳號」
- 已停用再停用：「帳號已經是停用狀態」
- 啟用中再恢復：「帳號已經是啟用狀態」

- [ ] **Step 1: 寫失敗的測試** `tests/admin/test_deactivate.py`
  - `test_deactivate_deletes_watches_and_promotes`：`fill_slots(7)`、alice 佔 1 個（共 8）、另一人 1 個 queued；停用 alice → 200、`is_active is False`、`slot_count == 0`、alice 的追蹤數為 0（含 paused、expired 都刪掉）、queued 那個變 active
  - `test_deactivate_deletes_refresh_tokens`：alice 登入過，停用後 `refresh_tokens` 沒有 alice 的資料，`POST /auth/refresh` 帶舊 cookie → 401
  - `test_deactivated_token_rejected`：alice 先拿到 access token，停用後用它 `GET /api/v1/me` → 401
  - `test_deactivate_keeps_shared_query_occupied`：alice 和 carol 追蹤同一組條件（都 active）、其他 7 組佔滿、dave 1 個 queued；停用 alice → carol 仍 active、dave 仍 queued
  - `test_cannot_deactivate_self`、`test_cannot_deactivate_demo`、`test_cannot_deactivate_admin`、`test_deactivate_twice`：各回 409 與上面的訊息
  - `test_deactivate_unknown_404`：隨機 UUID → 404
  - `test_reactivate`：停用後恢復 → 200、`is_active is True`、可以用原密碼 `POST /auth/login` 成功、追蹤數仍為 0
  - `test_reactivate_active_409`：對啟用中的帳號恢復 → 409「帳號已經是啟用狀態」
  - `test_non_admin_forbidden`：一般帳號呼叫兩個端點 → 403
- [ ] **Step 2: 跑測試確認失敗** `uv run pytest tests/admin/test_deactivate.py -v` → FAIL（404／405）
- [ ] **Step 3: 實作** 上列 Interfaces
- [ ] **Step 4: 跑測試確認通過** `uv run pytest tests/admin -v` → PASS
- [ ] **Step 5: Commit** `feat: 後台停用與恢復帳號`

### Task 3: 追蹤列表與刪除任何人的追蹤

**Files:**
- Modify: `backend/app/modules/watches/service.py`（抽出 `remove_watch`，`delete_watch` 改用它）
- Modify: `backend/app/modules/admin/service.py`、`schemas.py`、`router.py`
- Create: `backend/tests/admin/test_watches.py`

**Interfaces:**
- Produces:
  - `watches.service.remove_watch(session, watch: Watch, today: date) -> None`：刪除、`flush`、`rebalance`、`commit`。呼叫前要已取得 `acquire_watch_lock`。`delete_watch` 變成「取鎖 → `get_watch` → `remove_watch`」，行為不變
  - `admin.schemas.AdminWatchOut`：`public_id`、`owner_email: str`、`origin`、`destination`、`depart_date: date`、`return_date: date | None`、`status: str`、`created_at: datetime`
  - `admin.service.list_watches(session) -> list[AdminWatchOut]`：`status IN ('active','queued')` 且 `PriceQuery.is_demo` 為 false，依 `Watch.created_at, Watch.id` 舊到新
  - `admin.service.delete_any_watch(session, public_id, today) -> None`：取鎖 → 用 public_id 找（不限擁有者）→ 找不到 `WatchNotFound`（沿用 watches 的例外，router 轉 404「找不到追蹤」）→ 示範追蹤 `CannotDeleteDemoWatch`（409「不能刪除示範帳號的追蹤」）→ `remove_watch`
  - router：`GET /watches -> list[AdminWatchOut]`、`DELETE /watches/{public_id}` → 204

- [ ] **Step 1: 寫失敗的測試** `tests/admin/test_watches.py`
  - `test_list_watches`：alice 有 active、queued、paused、expired 各 1，加上示範帳號的追蹤 → 只回 alice 的 active 與 queued，舊到新，`owner_email == "alice@example.com"`
  - `test_delete_any_watch_promotes`：`fill_slots(8)`、alice 1 個 queued；admin 刪掉 filler 的 1 個 → 204、alice 的變 active
  - `test_delete_demo_watch_409`、`test_delete_unknown_404`
  - `test_non_admin_forbidden`：一般帳號 `GET`、`DELETE` → 403
- [ ] **Step 2: 跑測試確認失敗** `uv run pytest tests/admin/test_watches.py -v` → FAIL
- [ ] **Step 3: 實作** 上列 Interfaces
- [ ] **Step 4: 跑測試確認通過（含既有的刪除測試，確認重構沒改行為）** `uv run pytest tests/admin tests/watches -v` → PASS
- [ ] **Step 5: Commit** `feat: 後台列出與刪除任何人的追蹤`

### Task 4: 用量

**Files:**
- Create: `backend/app/modules/admin/usage.py`
- Modify: `backend/app/modules/admin/schemas.py`、`router.py`
- Create: `backend/tests/admin/test_usage.py`

**Interfaces:**
- Consumes: `prices.deps.ProviderDep`、`prices.budget.daily_budget`、`prices.checker.today_start`／`usage_month`、`prices.instant.INSTANT_TIMEOUT_SECONDS`、`watches.slots.occupied_query_ids`／`MAX_ACTIVE_QUERIES`、`ApiUsage`、`InstantCheckUsage`、`AlertDelivery`
- Produces:
  - `admin.schemas.AdminUsageOut`：`serpapi_remaining: int | None`、`daily_budget: int | None`、`month_calls: int`、`checked_today: int`、`instant_today: int`、`instant_remaining: int | None`、`slots_used: int`、`slots_max: int`、`queued: int`、`email_sent: int`、`email_failed: int`、`email_pending: int`
  - `admin.usage.get_usage(session, provider: PriceProvider, today: date, now: datetime) -> AdminUsageOut`
  - router：`GET /usage -> AdminUsageOut`（`now` 用 `datetime.now(UTC)`）

各欄位算法照 spec「用量」一節。補充：
- 剩餘額度用 `async with asyncio.timeout(INSTANT_TIMEOUT_SECONDS)` 包住 `provider.remaining_quota()`，捕捉 `ProviderError` 與 `TimeoutError` 並 `logger.warning`，結果當 `None`
- `month_calls` 用 `provider.name` 與 `usage_month(now)` 查 `api_usage`
- `checked_today`、`queued` 排除示範資料（`PriceQuery.is_demo` 為 false）
- 寄信的「本月」：`AlertDelivery.created_at >= 台灣時間本月 1 日 00:00`
- `instant_remaining = max(0, daily_budget - slots_used - instant_today)`

- [ ] **Step 1: 寫失敗的測試** `tests/admin/test_usage.py`，用 `tests/prices/conftest.py` 的 `FakeProvider`，以 `app.dependency_overrides[get_price_provider]` 換掉
  - `test_usage_numbers`：`TODAY = 2026-11-01`（30 天），`FakeProvider(remaining=270)` → `daily_budget == 9`；佈置 8 組佔名額、1 個 queued、今天查過 3 組（其中 1 組是示範資料，不算 → `checked_today == 2`）、`instant_check_usage` 今天兩人共 2 次、昨天 5 次（不算）、`api_usage` 本月 70 → 斷言 `serpapi_remaining == 270`、`month_calls == 70`、`instant_today == 2`、`instant_remaining == 0`（9 − 8 − 2 取 0）、`slots_used == 8`、`slots_max == 8`、`queued == 1`
  - `test_usage_instant_remaining_positive`：remaining 使 `daily_budget == 12`、佔名額 8、立即查價 1 → `instant_remaining == 3`
  - `test_usage_provider_failure`：`FakeProvider(remaining=ProviderError("x"))` 與 `FakeProvider(remaining=TimeoutError())` 各一次 → 200，`serpapi_remaining`、`daily_budget`、`instant_remaining` 皆 `None`，`slots_used` 照常
  - `test_usage_email_counts`：本月 sent 2、failed 1、pending 1、skipped 1，上個月 sent 3 → `email_sent == 2`、`email_failed == 1`、`email_pending == 1`
  - `test_usage_email_month_taipei`：`created_at = 2026-10-31T17:00Z` 的 sent → 算進 11 月；`2026-10-31T15:59Z`（台灣 10/31 23:59）→ 不算
  - `test_usage_forbidden`：一般帳號 → 403，且 `FakeProvider` 的 `remaining_quota` 沒被呼叫（用 `on_remaining` 記錄）
- [ ] **Step 2: 跑測試確認失敗** `uv run pytest tests/admin/test_usage.py -v` → FAIL
- [ ] **Step 3: 實作** 上列 Interfaces
- [ ] **Step 4: 跑全部後端測試** `uv run pytest -q` → 全部 PASS
- [ ] **Step 5: 更新 OpenAPI** `uv run python scripts/export_openapi.py`，確認 `frontend/openapi.json` 多了 `/api/v1/admin/*`
- [ ] **Step 6: Commit**（含 `frontend/openapi.json`）`feat: 後台用量 API`

### Task 5: 前端後台頁

**Files:**
- Modify: `frontend/src/api/schema.d.ts`（`npm run gen:api` 產生）
- Modify: `frontend/src/api/queries.ts`
- Create: `frontend/src/pages/AdminPage.tsx`、`frontend/src/pages/AdminPage.test.tsx`
- Modify: `frontend/src/routes.tsx`（`Layout` 底下加 `<Route path="/admin" element={<AdminPage />} />`）
- Modify: `frontend/src/components/NavBar.tsx`（電腦版 `nav` 與 `MobileMenu` 各加「後台」`NavLink`，只在 `user.role === "admin"` 時顯示）
- Modify: `frontend/src/test/fixtures.ts`（加 `admin: Me`，`role: "admin"`）

**Interfaces:**
- Consumes: Task 1～4 的 API 與型別（`AdminUserOut`、`AdminWatchOut`、`AdminUsageOut`）
- Produces（`queries.ts`）：
  - 型別 `AdminUser`、`AdminWatch`、`AdminUsage`（`components["schemas"][...]`）
  - `keys.admin = ["admin"] as const`，`keys.adminUsers`、`keys.adminWatches`、`keys.adminUsage` 都以 `"admin"` 開頭
  - `useAdminUsers()`、`useAdminWatches()`、`useAdminUsage()`
  - `useDeactivateUser()`、`useReactivateUser()`：參數 `publicId: string`
  - `useAdminDeleteWatch()`：參數 `publicId: string`
  - 三個 mutation 成功後都讓 `keys.admin` 與 `keys.watches` 失效（`keys.watches` 不加 `exact`，admin 自己的追蹤詳情也要重抓）

畫面規則（照 spec「前端」一節）：
- 非 admin：`AdminPage` 直接回 `<NotFoundPage />`，且不發任何 admin 請求
- 用量區塊各列文字照 spec 草圖；`null` 時剩餘額度顯示「查詢失敗」，今天預算與立即查價剩餘顯示「—」；今天預算後面加「（依目前剩餘額度計算）」
- 帳號狀態文字：「正常」「已停用」「示範帳號」「管理員」；按鈕「停用」「恢復」；自己、示範帳號、管理員不顯示停用按鈕
- 追蹤狀態用現有 `StatusBadge`
- 停用確認：標題「停用帳號」，訊息 `停用 ${email} 後，他的 ${slot_count} 個追蹤會被刪除，恢復帳號後也不會回來。`，確認鈕「停用」
  - 注意 `slot_count` 只算 active／queued；訊息裡的數字用它即可（暫停、過期的不佔名額，spec 不要求列出）
- 刪除確認：標題「刪除追蹤」，訊息 `確定要刪除 ${owner_email} 的 ${origin}→${destination}（${出發日}）嗎？`，確認鈕「刪除」
- 成功 Toast：「已停用帳號」「已恢復帳號」「已刪除追蹤」；失敗用 `api/errors.ts` 既有的錯誤訊息轉換顯示 Toast
- 某個區塊載入失敗用 `QueryError`，不影響其他區塊

- [ ] **Step 1: 產生型別** `cd frontend && npm run gen:api`，`git diff` 只多 admin 相關型別
- [ ] **Step 2: 寫失敗的測試** `AdminPage.test.tsx`（用 `renderApp`、`server.use` 提供三個 GET）
  - `非 admin 看到找不到頁面`：`renderApp("/admin")`（alice）→ 出現 `NotFoundPage` 的文字，且沒有送出 `/api/v1/admin/*`（MSW 沒設定該路由，有送出就會失敗）
  - `導覽列只有 admin 有後台連結`：admin 有「後台」、alice 沒有
  - `顯示用量`：斷言「180 次」「8 / 8 組，排隊中 5 個」「成功 30｜失敗 1｜待寄 0」等文字
  - `顯示查詢失敗`：`serpapi_remaining: null` → 「查詢失敗」，其他數字照常
  - `停用帳號`：點 alice 的「停用」→ 對話框訊息含「2 個追蹤會被刪除」→ 確認 → 送出 `POST /api/v1/admin/users/{id}/deactivate` → 重新抓列表、Toast「已停用帳號」
  - `自己與示範帳號沒有停用按鈕`
  - `刪除追蹤`：點「刪除」→ 確認 → 送出 `DELETE` → Toast「已刪除追蹤」
- [ ] **Step 3: 跑測試確認失敗** `npm test -- AdminPage` → FAIL
- [ ] **Step 4: 實作** 上列檔案
- [ ] **Step 5: 跑前端全部檢查** `npm run lint && npm run typecheck && npm test && npm run build` → 全部通過
- [ ] **Step 6: Commit** `feat: 前端後台頁`

### Task 6: 文件

**Files:**
- Modify: `docs/deploy-runbook.md`（第 6 節「之後的更新」加「設定管理員」小節：Neon SQL Editor 執行 `UPDATE users SET role = 'admin' WHERE email = '<你的 Email>';`，執行後重新整理網站，導覽列出現「後台」）
- Modify: `docs/01-requirements.md`（US-10 標註已完成；新增 US-12「管理員／刪除任何人的追蹤、停用與恢復帳號／處理惡意佔用名額／M1 後」）
- Modify: `docs/02-design.md`、`docs/03-development.md` 中提到 US-10 延後或 `require_admin` 的地方（用 `grep -n "US-10\|require_admin\|管理員" docs/0*.md` 找）
- Modify: `CLAUDE.md`「目前狀態」加一行後台子專案（spec／plan 路徑、尚未部署）

- [ ] **Step 1: 修改上列文件**
- [ ] **Step 2: 確認沒有遺漏** `grep -rn "US-10" docs/0*.md CLAUDE.md` 每一處都已更新為現況
- [ ] **Step 3: Commit** `docs: 後台的需求、部署步驟與狀態`

### 完成後
- 在 `python:3.14-slim` 容器跑一次全部後端測試（CI 是 Linux）
- 全分支審查後 push，使用者開 PR；合併後自動部署，使用者在 Neon 設定 admin，再一起做線上驗收（不需花 SerpApi 額度）
