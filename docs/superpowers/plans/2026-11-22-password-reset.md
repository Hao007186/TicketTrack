# 忘記密碼、修改密碼與登入失敗提醒 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓使用者能用 Email 重設密碼、在設定頁改密碼，並在登入打錯時看到剩餘次數和鎖定時間。

**Architecture:** 後端在 `auth` 模組新增 `passwords.py`（重設與修改密碼的業務規則）和 `password_reset_tokens` 表，寫法比照現有 `refresh_tokens`；登入失敗的計數抽成共用函式，讓登入和修改密碼共用。前端新增 `/forgot-password`、`/reset-password` 兩頁和設定頁的「修改密碼」卡片。

**Tech Stack:** FastAPI、SQLAlchemy async、Alembic、pytest；React 19、TanStack Query、openapi-fetch、Vitest + MSW

**Spec:** `docs/superpowers/specs/2026-11-22-password-reset-design.md`

## Global Constraints
- 文件、訊息、commit 說明用繁體中文；commit 用 Conventional Commits，結尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 本機測試資料庫：`TEST_DATABASE_URL=postgresql+psycopg://farewatch:farewatch@127.0.0.1:55432/farewatch_test`（後端指令都在 `backend/` 下用 `uv run` 執行）
- 每個後端 task 結束前：`uv run ruff check`、`uv run ruff format --check`、`uv run mypy` 都要過；前端 task：`npm run lint`、`npm run typecheck`、`npm test`
- 鎖定規則一律從 `service.MAX_FAILED_LOGINS`（5）、`service.LOCKOUT_DURATION`（15 分鐘）算，不寫死在字串裡
- 重設 token：`security.new_refresh_token()` 產生、`security.hash_refresh_token()` 雜湊，**30 分鐘**有效；同一使用者 **5 分鐘**內只能建立一筆
- 新密碼長度沿用註冊：`Field(min_length=8, max_length=128)`
- 重設信連結：`{APP_BASE_URL 去掉結尾 /}/reset-password?token=<token>`
- 時間一律由 router 傳 `now = datetime.now(UTC)` 進 service，service 不自己取時間，`created_at`／`used_at`／`revoked_at` 都用這個 `now` 寫入（測試要能控制時間；測試的 transaction 裡 DB 的 `now()` 不會變）

## Review Focus
1. Email 大小寫或前後空白不同（`" Alice@Example.com "`）：申請重設要找到同一個帳號 → Task 2 `test_request_normalizes_email`
2. 重設連結的 token 是亂打的、空字串，或在網址被截斷：回 400，不是 500 或 422 → Task 2 `test_confirm_garbage_token`
3. 剛好在第 5 次錯誤之後輸入**正確**密碼：仍然是 423，不能因為密碼對了就繞過鎖定 → Task 1 `test_correct_password_while_locked_still_423`
4. 重設時填的新密碼跟舊密碼一樣：允許（spec 只禁止修改密碼時相同），流程照常 → Task 2 `test_confirm_same_as_old_password_allowed`
5. 已登入的人在設定頁開著超過 15 分鐘才送出修改密碼：access token 過期後要自動 refresh 再送 → 由端點放在 `/api/v1/me/password` 保證；Task 4 `修改密碼走 /me 路徑`（MSW 只註冊該路徑）

---

### Task 1: 登入失敗提醒（剩餘次數、鎖定分鐘）

**Files:**
- Modify: `backend/app/modules/auth/service.py`
- Create: `backend/app/modules/auth/messages.py`
- Modify: `backend/app/modules/auth/router.py`
- Test: `backend/tests/auth/test_login.py`

**Interfaces:**
- Produces（service.py）：
  - `class WrongPassword(Exception)`，屬性 `remaining: int`（再錯幾次會鎖）
  - `class AccountLocked(Exception)`，改成帶 `minutes: int`
  - `InvalidCredentials` 不變（不帶次數，用於 Email 不存在、停用、示範帳號）
  - `def lock_minutes_left(locked_until: datetime, now: datetime) -> int`：無條件進位，最少 1
  - `async def check_password(session: AsyncSession, user: User, password: str, now: datetime) -> None`：已鎖定 → `AccountLocked(lock_minutes_left(...))`；密碼錯 → `failed_login_count += 1`，達到 `MAX_FAILED_LOGINS` 時設 `locked_until = now + LOCKOUT_DURATION`、計數歸 0、commit、丟 `AccountLocked(15)`，否則 commit、丟 `WrongPassword(MAX_FAILED_LOGINS - failed_login_count)`；密碼對 → `failed_login_count = 0`、`locked_until = None`（不 commit）
- Produces（messages.py）：`def wrong_password(remaining: int) -> str` → `f"Email 或密碼錯誤，再錯 {remaining} 次會鎖定 {LOCK} 分鐘"`；`def wrong_current_password(remaining: int) -> str` → `f"目前的密碼錯誤，再錯 {remaining} 次會鎖定 {LOCK} 分鐘"`；`def locked(minutes: int) -> str` → `f"登入失敗次數過多，帳號已鎖定，請約 {minutes} 分鐘後再試，或使用忘記密碼重設"`；`BAD_CREDENTIALS = "Email 或密碼錯誤"`（`LOCK` 由 `LOCKOUT_DURATION` 算）

- [ ] **Step 1: 改寫 / 新增 `test_login.py` 的測試**

`LOCKED` 常數改成用 `messages.locked(...)` 比對。新增或改寫：
```python
async def test_wrong_password_shows_remaining(client, user):
    resp = await _login(client, "wrong")
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Email 或密碼錯誤，再錯 4 次會鎖定 15 分鐘"

async def test_fifth_failure_locks_immediately(client, user):
    for _ in range(4):
        assert (await _login(client, "wrong")).status_code == 401
    resp = await _login(client, "wrong")
    assert resp.status_code == 423
    assert resp.json()["detail"] == "登入失敗次數過多，帳號已鎖定，請約 15 分鐘後再試，或使用忘記密碼重設"

async def test_locked_minutes_round_up(client, db_session, user):
    user.locked_until = datetime.now(UTC) + timedelta(minutes=11, seconds=5)
    await db_session.flush()
    resp = await _login(client)
    assert resp.status_code == 423 and "約 12 分鐘" in resp.json()["detail"]

async def test_correct_password_while_locked_still_423(...)  # 5 次錯後用正確密碼 → 423

async def test_unknown_email_no_count(client, user):
    resp = await client.post(URL, json={"email": "nobody@example.com", "password": "x"})
    assert resp.status_code == 401 and resp.json()["detail"] == "Email 或密碼錯誤"

async def test_inactive_user_locked_still_401(client, db_session):
    # is_active=False、locked_until 在未來 → 正確密碼與錯誤密碼都回 401「Email 或密碼錯誤」
async def test_demo_user_wrong_password_no_count_shown(...)  # 示範帳號打錯 → 401 不帶次數
```
既有的 `test_wrong_password_and_unknown_email_same_response` 改成只比狀態碼（401），因為訊息現在不同；其餘既有測試照常要過。

- [ ] **Step 2: 執行確認失敗**

Run: `uv run pytest tests/auth/test_login.py -v`
Expected: 新測試 FAIL（訊息不符）

- [ ] **Step 3: 實作**

`login` 的流程改成：找不到 → `verify_dummy_password` + `InvalidCredentials`；`check_password`，用 `try` 包住，若使用者 `not is_active or is_demo`，把 `WrongPassword`／`AccountLocked` 轉成 `InvalidCredentials`；通過後若 `not is_active or is_demo` 也丟 `InvalidCredentials`；最後 `issue_tokens`。`login` 加 `now: datetime` 參數。router：`WrongPassword` → 401 `messages.wrong_password(e.remaining)`、`AccountLocked` → 423 `messages.locked(e.minutes)`、`InvalidCredentials` → 401 `messages.BAD_CREDENTIALS`。

- [ ] **Step 4: 執行確認通過**

Run: `uv run pytest tests/auth -v`
Expected: 全部 PASS

- [ ] **Step 5: Commit** — `feat: 登入失敗時顯示剩餘次數與鎖定分鐘`

---

### Task 2: 忘記密碼（申請與完成重設）

**Files:**
- Modify: `backend/app/modules/auth/models.py`（新增 `PasswordResetToken`）
- Create: `backend/migrations/versions/20261122_<rev>_create_password_reset_tokens.py`（`down_revision = "7c1e4a92b3d5"`）
- Create: `backend/app/modules/notifications/deps.py`（把 `get_sender`、`SenderDep` 從 `prices/deps.py` 搬過來；`prices/deps.py` 改成 `from app.modules.notifications.deps import SenderDep, get_sender` 重新匯出，既有測試的 `dependency_overrides[get_sender]` 才不用改）
- Create: `backend/app/modules/auth/passwords.py`
- Modify: `backend/app/modules/auth/schemas.py`、`backend/app/modules/auth/router.py`
- Test: `backend/tests/auth/test_password_reset.py`

**Interfaces:**
- Consumes: Task 1 的 `service.check_password`（本 task 不用）、`security.new_refresh_token`、`security.hash_refresh_token`、`notifications.email.EmailMessage/EmailSender/EmailError`
- Produces（models.py）：`PasswordResetToken`：`id`、`user_id`（FK users.id CASCADE、index）、`token_hash: String(64) unique`、`expires_at`、`used_at: datetime | None`、`created_at`（server_default now，但 service 一律明確寫入 `now`）
- Produces（passwords.py）：
  - `RESET_TOKEN_TTL = timedelta(minutes=30)`、`RESET_COOLDOWN = timedelta(minutes=5)`
  - `class InvalidResetToken(Exception)`
  - `def build_reset_email(to: str, token: str, base_url: str) -> EmailMessage`：主旨 `FareWatch 重設密碼`，內文含連結、30 分鐘、只能用一次、非本人可忽略、重設後所有裝置登出
  - `async def set_password(session: AsyncSession, user: User, new_password: str, now: datetime) -> None`：更新雜湊、`failed_login_count = 0`、`locked_until = None`、作廢他所有 `used_at IS NULL` 的重設 token、作廢他所有 `revoked_at IS NULL` 的 refresh token；不 commit（Task 3 也用）
  - `async def request_reset(session: AsyncSession, sender: EmailSender, base_url: str, email: str, now: datetime) -> None`
  - `async def confirm_reset(session: AsyncSession, token: str, new_password: str, now: datetime) -> None`
- Produces（schemas.py）：`PasswordResetRequest(email: EmailStr)`、`PasswordResetConfirm(token: str, new_password: str = Field(min_length=8, max_length=128))`、`MessageResponse(detail: str)`
- Produces（API）：
  - `POST /api/v1/auth/password-reset/request` → 202 `{"detail": "如果這個 Email 有註冊，重設信已寄出，請在 30 分鐘內點信裡的連結"}`
  - `POST /api/v1/auth/password-reset/confirm` → 204；失效 → 400 `「重設連結已失效或已使用，請重新申請」`

- [ ] **Step 1: 寫測試 `tests/auth/test_password_reset.py`**

用 `FakeSender`（`tests/notifications/test_notifier.py`）覆寫 `get_sender`。從寄出的信裡用正則抓出 token。API 層：
```python
REQUEST = "/api/v1/auth/password-reset/request"
CONFIRM = "/api/v1/auth/password-reset/confirm"
ACK = "如果這個 Email 有註冊，重設信已寄出，請在 30 分鐘內點信裡的連結"
INVALID = "重設連結已失效或已使用，請重新申請"

async def test_request_same_response_for_all(client, db_session, sender):
    # alice（正常）、停用帳號、示範帳號、不存在的 Email → 都是 202 + ACK
    # sender.attempts 只有 alice 一封，to == "alice@example.com"、subject == "FareWatch 重設密碼"
    # 信件內文包含 f"{get_settings().app_base_url.rstrip('/')}/reset-password?token="（測試環境預設 http://localhost:5173）
async def test_request_normalizes_email(...)  # " Alice@Example.com " → 寄給 alice
async def test_request_cooldown(...)  # 連續兩次 → 只寄一封，兩次都 202 + ACK
async def test_send_failure_still_202(...)  # FakeSender(error="boom") → 202，token 已寫入
async def test_confirm_resets_password(client, db_session, sender):
    # 申請 → 從信抓 token → confirm 新密碼 "new-password-1" → 204
    # 舊密碼登入 401；新密碼登入 200；先前登入拿到的 refresh cookie 呼叫 /auth/refresh → 401
async def test_confirm_unlocks_account(...)  # 先設 locked_until 在未來 → confirm 後新密碼可登入
async def test_confirm_twice_fails(...)  # 第二次 400 + INVALID
async def test_confirm_garbage_token(...)  # token "" 和 "abc" → 400 + INVALID
async def test_confirm_same_as_old_password_allowed(...)  # 新密碼 == 舊密碼 → 204
async def test_confirm_short_password_422(...)  # 7 字 → 422
```
service 層（直接呼叫，控制 `now`）：
```python
async def test_new_request_voids_old_token(db_session):
    # request_reset(now=t0) → token A；request_reset(now=t0+6min) → token B
    # confirm_reset(A, now=t0+7min) 丟 InvalidResetToken；confirm_reset(B, ...) 成功
async def test_token_expires_after_30_minutes(db_session):
    # now=t0 建立；confirm 於 t0+30min+1s → InvalidResetToken；另一筆於 t0+29min → 成功
async def test_cooldown_lifts_after_5_minutes(db_session):  # t0、t0+4min → 1 封；t0+5min+1s → 2 封
async def test_confirm_for_deactivated_user_fails(db_session):  # 建 token 後把使用者停用 → InvalidResetToken
```

- [ ] **Step 2: 執行確認失敗**

Run: `uv run pytest tests/auth/test_password_reset.py -v`
Expected: FAIL（模組或路由不存在）

- [ ] **Step 3: model、migration、`notifications/deps.py`**

migration 手寫（比照 `20261103_7c1e4a92b3d5`），`downgrade` 刪表。`app/db/models.py` 已經 import `auth.models`，不用改。

- [ ] **Step 4: 實作 `passwords.py`、schemas、router**

`request_reset`：`normalize_email` → 找使用者；不存在／停用／示範 → return；查他 `created_at > now - RESET_COOLDOWN` 的 token 存在 → return；作廢舊的未用 token → 新增 token（`created_at=now`、`expires_at=now+RESET_TOKEN_TTL`）→ commit → `sender.send(build_reset_email(...))`，`EmailError` 時 `logger.warning` 只記使用者 id 與錯誤，不記 token。
`confirm_reset`：條件式 `update(PasswordResetToken).where(token_hash == ..., used_at IS NULL, expires_at > now).values(used_at=now).returning(user_id)`；拿不到 → `InvalidResetToken`；使用者停用或示範 → rollback 後 `InvalidResetToken`；否則 `set_password` → commit。
router 的 request 端點 `status_code=202`，回 `MessageResponse`；confirm 端點 `status_code=204`。

- [ ] **Step 5: 執行確認通過**

Run: `uv run pytest -v`
Expected: 全部 PASS（包括 `test_migrations.py` 的 upgrade／downgrade）

- [ ] **Step 6: Commit** — `feat: 忘記密碼（申請重設信與完成重設）`

---

### Task 3: 修改密碼 API

**Files:**
- Modify: `backend/app/modules/users/router.py`、`backend/app/modules/users/schemas.py`（或 auth/schemas.py，二選一，放在 router import 得到的地方）
- Modify: `backend/app/modules/auth/passwords.py`
- Test: `backend/tests/auth/test_change_password.py`

**Interfaces:**
- Consumes: Task 1 `service.check_password`、`WrongPassword`、`AccountLocked`、`messages.wrong_current_password`、`messages.locked`；Task 2 `passwords.set_password`；`service.issue_tokens`；`auth.router.set_refresh_cookie`；`WritableUser`
- Produces：
  - `class SamePassword(Exception)`
  - `async def change_password(session: AsyncSession, settings: Settings, user: User, current_password: str, new_password: str, now: datetime) -> service.TokenPair`：`check_password` → 新舊相同丟 `SamePassword` → `set_password` → `issue_tokens`（它會 commit）
  - `ChangePasswordRequest(current_password: str, new_password: str = Field(min_length=8, max_length=128))`
  - `POST /api/v1/me/password` → 200 `TokenResponse` + 設定 refresh cookie；`WrongPassword` → 400 `wrong_current_password`；`AccountLocked` → 423 `locked`；`SamePassword` → 400 `「新密碼不能和目前的密碼相同」`；示範帳號 → 403（`WritableUser` 既有行為）

- [ ] **Step 1: 寫測試**
```python
URL = "/api/v1/me/password"
async def test_change_password_success(client, db_session):
    # 登入兩次（兩台裝置）→ 用第一台的 access token 改密碼 → 200，有新 access_token 與 set-cookie
    # 第二台的 refresh cookie → /auth/refresh 401；回應給的新 refresh cookie → /auth/refresh 200
    # 舊密碼登入 401、新密碼登入 200
async def test_wrong_current_password_counts(...)  # 400 「目前的密碼錯誤，再錯 4 次會鎖定 15 分鐘」
async def test_fifth_wrong_current_password_locks(...)  # 第 5 次 → 423；之後用正確密碼登入也 423
async def test_same_password_rejected(...)  # 400「新密碼不能和目前的密碼相同」
async def test_demo_forbidden(...)  # 示範帳號 → 403
async def test_requires_login(...)  # 沒帶 token → 401
```
登入／refresh 的 cookie 操作用 `tests/auth/conftest.py` 的 `refresh_with`、`cookie_token`。

- [ ] **Step 2: 確認失敗** — `uv run pytest tests/auth/test_change_password.py -v` → FAIL（404）
- [ ] **Step 3: 實作**（如上 Interfaces）
- [ ] **Step 4: 確認通過** — `uv run pytest -v` → 全部 PASS
- [ ] **Step 5: 更新 OpenAPI** — `uv run python scripts/export_openapi.py`，確認 `frontend/openapi.json` 有 3 個新路徑
- [ ] **Step 6: Commit** — `feat: 已登入時修改密碼`（含 `frontend/openapi.json`）

---

### Task 4: 前端忘記密碼、重設密碼頁與登入頁提示

**Files:**
- Modify: `frontend/src/api/schema.d.ts`（`npm run gen:api` 產生）
- Modify: `frontend/src/auth/context.ts`、`frontend/src/auth/AuthProvider.tsx`
- Modify: `frontend/src/pages/LoginPage.tsx`、`frontend/src/routes.tsx`
- Create: `frontend/src/pages/ForgotPasswordPage.tsx`、`frontend/src/pages/ResetPasswordPage.tsx`
- Modify: `frontend/src/components/ui.ts`（新增 `successBox = "rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700"`）
- Test: `frontend/src/pages/LoginPage.test.tsx`、`frontend/src/pages/ForgotPasswordPage.test.tsx`、`frontend/src/pages/ResetPasswordPage.test.tsx`

**Interfaces:**
- Consumes: Task 2 的兩個端點
- Produces：`Auth.clearSession(): void`（`setAccessToken(null)`、`queryClient.clear()`、`setUser(null)`，不呼叫後端、不導頁）

- [ ] **Step 1: 產生型別** — `npm run gen:api`，確認 `schema.d.ts` 有新路徑
- [ ] **Step 2: 寫測試**

`LoginPage.test.tsx` 新增：
- `有「忘記密碼？」連結`：點了 location 變 `/forgot-password`
- `423 時顯示重設連結`：MSW 回 423 `{detail: "登入失敗次數過多，帳號已鎖定，請約 15 分鐘後再試，或使用忘記密碼重設"}` → 顯示該訊息，且有名稱為「重設密碼」的連結指向 `/forgot-password`；401 時沒有這個連結
- `reset=1 顯示成功提示`：`renderApp("/login?reset=1", { user: null })` → 看得到「密碼已重設，請用新密碼登入」

`ForgotPasswordPage.test.tsx`：
- `送出後顯示後端訊息`：MSW 回 202 `{detail: ACK}` → 顯示 ACK、Email 欄位消失、有「回到登入」連結（→ `/login`）；並檢查送出的 body 是 `{ email: "alice@example.com" }`

`ResetPasswordPage.test.tsx`：
- `成功後導到登入頁並顯示提示`：`/reset-password?token=abc`，MSW confirm 回 204 並記錄 body → body 是 `{ token: "abc", new_password: "new-password-1" }`；location 變 `/login?reset=1`；看得到成功提示
- `已登入的人重設後被登出`：`renderApp("/reset-password?token=abc", { user: alice })` → 成功後停在 `/login?reset=1`（沒有被導到 `/watches`）
- `兩次密碼不同`：顯示「兩次輸入的密碼不一樣」，不送請求
- `少於 8 字`：顯示「密碼至少 8 個字」，不送請求
- `連結失效`：MSW 回 400 `{detail: INVALID}` → 顯示 INVALID 和「重新申請」連結（→ `/forgot-password`）
- `沒有 token`：`/reset-password` → 顯示「連結不完整」和「重新申請」連結，沒有表單

- [ ] **Step 3: 確認失敗** — `npm test` → 新測試 FAIL
- [ ] **Step 4: 實作**

兩個新頁沿用 `AuthCard`、`input`、`label`、`buttonPrimary`、`errorBox`；路由放在 `RequireAuth` 外面。登入頁：密碼欄位下方右對齊「忘記密碼？」；錯誤時保留 `ApiError.status`，等於 423 才多顯示「重設密碼」連結；`?reset=1` 時表單上方顯示 `successBox`。重設頁成功時 `clearSession()` 後 `navigate("/login?reset=1", { replace: true })`。

- [ ] **Step 5: 確認通過** — `npm run lint && npm run typecheck && npm test` → 全部 PASS
- [ ] **Step 6: Commit** — `feat: 前端忘記密碼與重設密碼頁、登入頁鎖定提示`

---

### Task 5: 設定頁修改密碼

**Files:**
- Modify: `frontend/src/pages/SettingsPage.tsx`
- Modify: `frontend/src/api/queries.ts`（新增 `useChangePassword()`）
- Test: `frontend/src/pages/SettingsPage.test.tsx`

**Interfaces:**
- Consumes: Task 3 `POST /api/v1/me/password`；`auth/token.ts` 的 `setAccessToken`
- Produces：`useChangePassword()`：`mutationFn({ current_password, new_password })`，成功時 `setAccessToken(data.access_token)`

- [ ] **Step 1: 寫測試**（`SettingsPage.test.tsx`）
- `修改密碼成功`：填三個欄位（label：「目前密碼」、「新密碼」、「確認新密碼」）→ 按「更新密碼」→ MSW（只註冊 `/api/v1/me/password`）回 200 → 顯示「密碼已更新，其他裝置已登出」、三個欄位清空；body 是 `{ current_password, new_password }`
- `目前密碼錯誤顯示後端訊息`：回 400 `{detail: "目前的密碼錯誤，再錯 4 次會鎖定 15 分鐘"}` → 顯示該訊息
- `確認密碼不同`：顯示「兩次輸入的密碼不一樣」，不送請求
- `示範帳號按鈕停用`：`renderApp("/settings", { user: demoUser })`（fixtures 已有示範使用者就用，沒有就在 fixtures 新增）→「更新密碼」按鈕 disabled

- [ ] **Step 2: 確認失敗** — `npm test -- SettingsPage` → FAIL
- [ ] **Step 3: 實作** — 新增「修改密碼」卡片（`card`），放在「通知」卡片下方，送出按鈕用 `WriteButton`；前端驗證規則和 Task 4 重設頁相同（可抽共用函式 `validateNewPassword(pw, confirm): string | null` 放 `frontend/src/lib/password.ts`，兩邊共用）
- [ ] **Step 4: 確認通過** — `npm run lint && npm run typecheck && npm test && npm run build` → 全部 PASS
- [ ] **Step 5: Commit** — `feat: 設定頁修改密碼`

---

### Task 6: 文件

**Files:**
- Modify: `docs/01-requirements.md`（第 37 行附近：忘記密碼移出 v2／M4，標為已完成）
- Modify: `docs/02-design.md`（第 181 行附近：v2 只剩 LINE 登入；認證段落補上重設與修改密碼的端點）
- Modify: `docs/architecture.md`（第 64 行 M4 拿掉忘記密碼；第 108 行第 20 項決策改成「提前於 M1 後完成（2026-11-22）」）
- Modify: `docs/deploy-runbook.md`（第 4 節驗收或第 6 節：新增「忘記密碼驗收」：正式站申請重設 → 收信 → 重設 → 舊密碼不能登入、新密碼可以；並註明不需要新增 AWS 資源）

- [ ] **Step 1: 修改上述文件**
- [ ] **Step 2: Commit** — `docs: 忘記密碼提前完成，更新需求、設計、架構與 runbook`
