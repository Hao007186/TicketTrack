# 立即查價 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立追蹤或修改查價條件後立刻查價一次，表單也能在填目標價前查目前價格，兩者共用每人每天 3 次的上限。

**Architecture:** 後端新增 `prices/instant.py`，`check_query` 是共用流程，兩個新 API 都呼叫它，並重用 `checker.py` 的搶下、還原與記錄。前端在送出成功時發第二個請求，結果透過 React Query 的 mutation 狀態讓詳情頁讀取。API Lambda 加上寄信權限。

**Tech Stack:** FastAPI、SQLAlchemy async、Alembic、pytest；React、TanStack Query v5、vitest + MSW；Terraform。

**Spec:** [2026-11-03-instant-price-check-design.md](../specs/2026-11-03-instant-price-check-design.md)

## Global Constraints
- 每人每天 3 次，日期一律用台灣時間（`today` 參數，來自 `get_today`）
- 全站上限：當天立即查價總數 < `daily_budget(remaining, today)`；`remaining` 是 None（mock）時不檢查
- 查額度與查價合計 15 秒；排程的 60 秒不變；通知信每次最多 5 封
- 測試不花額度：一律用 `tests/prices/conftest.py` 的 `FakeProvider`、`tests/notifications/test_notifier.py` 的 `FakeSender`
- 改了 API 要依序在 `backend/` 執行 `uv run python scripts/export_openapi.py`、在 `frontend/` 執行 `npm run gen:api`，CI 會 diff
- 新 model 放在已註冊的 `prices/models.py`；migration 接在 `329410054c37` 之後（先確認 head）
- 部署的指令都由使用者同意後才執行（Task 6）
- Commit 用 Conventional Commits，文字用繁體中文

## Review Focus
1. 出發日超出可查範圍時按表單查價（`referenceConditions` 不檢查範圍）：顯示後端 422 的訊息，不是「查價暫時失敗」→ Task 5 測試
2. 查價進行中改了條件：舊條件的結果不能顯示成新條件的價格 → Task 5 測試
3. 連按兩次表單查價：進行中按鈕停用，只發一個請求 → Task 5 測試
4. 追蹤建立成功但查價請求斷線：追蹤正常顯示，只出現失敗提示，不跳全域錯誤 → Task 4 測試
5. 表單查價後才建立追蹤，或查價中就送出：不重複花額度 → Task 3 測試

---

### Task 1: 次數紀錄（資料表與扣回）

**Files:**
- Create: `backend/migrations/versions/20261103_<rev>_create_instant_check_usage.py`
- Create: `backend/app/modules/prices/instant.py`
- Modify: `backend/app/modules/prices/models.py`
- Test: `backend/tests/prices/test_instant_usage.py`

**Interfaces:**
- Produces:
  - model `InstantCheckUsage(user_id, day, count)`
  - `MAX_INSTANT_CHECKS_PER_DAY = 3`
  - `async def reserve_slot(session, user_id: int, today: date, budget: int | None) -> Literal["ok", "user_limit", "site_limit"]`：拿鎖、檢查、加 1、commit
  - `async def refund_slot(session, user_id: int, today: date) -> None`：`count - 1` 並 commit

- [ ] **Step 1: 寫失敗的測試**

```python
async def test_fourth_reserve_is_user_limit(db_session):
    user = await create_user(db_session)
    for _ in range(3):
        assert await reserve_slot(db_session, user.id, TODAY, None) == "ok"
    assert await reserve_slot(db_session, user.id, TODAY, None) == "user_limit"

async def test_other_user_and_next_day_are_independent(db_session): ...
    # alice 用完後：bob 當天回 ok；alice 在 TODAY + 1 天回 ok

async def test_site_limit_counts_all_users(db_session): ...
    # alice、bob 各 1 次，budget=2 時 carol 回 site_limit，且 count 沒增加

async def test_none_budget_skips_site_limit(db_session): ...

async def test_refund_gives_slot_back(db_session): ...
    # 3 次用完 → refund → 再 reserve 回 ok

async def test_concurrent_reserves_never_exceed_limit(engine): ...
    # 用 engine 開 6 個獨立 session（db_session 共用連線，測不到鎖），asyncio.gather 同時 reserve，
    # "ok" 正好 3 個；在 finally 刪掉這個測試 commit 的 user 與紀錄
```

- [ ] **Step 2: 執行確認失敗**

Run（`backend/`）：`uv run pytest tests/prices/test_instant_usage.py -v`
Expected: FAIL，`ImportError`

- [ ] **Step 3: 實作 model、migration 與兩個函式**

主鍵 `(user_id, day)`，`user_id` 的 FK 用 `ondelete="CASCADE"`。migration 用 `uv run python -m alembic revision --autogenerate` 產生後檢查內容。鎖用 `pg_advisory_xact_lock`，新常數 `INSTANT_LOCK_KEY = 0x46415246`（和 `WATCH_LOCK_KEY` 不同）。加 1 用 `insert ... on_conflict_do_update`，和 `api_usage` 相同。

- [ ] **Step 4: 執行確認通過**

Run：`uv run pytest tests/prices/test_instant_usage.py tests/test_migrations.py tests/test_entrypoints.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/migrations backend/app/modules/prices backend/tests/prices/test_instant_usage.py
git commit -m "feat: 新增立即查價的每人每天次數紀錄"
```

### Task 2: 共用查價流程與寄信上限

**Files:**
- Modify: `backend/app/modules/prices/instant.py`
- Modify: `backend/app/modules/prices/checker.py`（`_restore` 改名 `restore_query`）
- Modify: `backend/app/modules/notifications/notifier.py`
- Test: `backend/tests/prices/test_instant.py`、`backend/tests/notifications/test_notifier.py`

**Interfaces:**
- Consumes: Task 1 的 `reserve_slot`、`refund_slot`；`checker.claim_query`、`record_result`、`today_start`、`usage_month`
- Produces:
  - `InstantResult = Literal["checked", "no_result", "already_checked", "not_eligible", "user_limit", "site_limit", "quota_exhausted", "failed"]`
  - `INSTANT_TIMEOUT_SECONDS = 15`、`MAX_EMAILS_PER_CHECK = 5`
  - `async def check_query(session, provider: PriceProvider, sender: EmailSender, base_url: str, user_id: int, query: PriceQuery, today: date, now: Callable[[], datetime] = _utcnow) -> InstantResult`
  - `async def check_watch(session, provider, sender, base_url, watch: Watch, today, now=_utcnow) -> InstantResult`：先判斷 `not_eligible`，再呼叫 `check_query`
  - `send_pending(..., limit: int | None = None)`

- [ ] **Step 1: 寫失敗的測試**

```python
async def test_checked_records_price_and_counts(db_session): ...
    # provider.calls 長度 1、有一筆 snapshot、usage count == 1、回 "checked"
async def test_no_result_still_counts(db_session): ...
async def test_already_checked_today_is_free(db_session): ...
    # last_checked_at 是今天：回 already_checked、calls 為空、沒有 usage
async def test_checked_yesterday_taipei_is_not_already_checked(db_session): ...
    # last_checked_at = 台灣時間昨天 23:59；UTC 同日的情況也要回 checked
async def test_not_eligible_statuses(db_session): ...
    # paused、queued、expired、出發日 = TODAY + 2 都回 not_eligible，calls 為空
async def test_user_limit_does_not_search(db_session): ...
async def test_site_limit_uses_daily_budget(db_session): ...
async def test_quota_exhausted_notifies(db_session): ...
    # remaining=0：回 quota_exhausted、calls 為空、有 active 追蹤的使用者收到系統通知
async def test_remaining_failure_is_failed(db_session): ...
    # remaining=ProviderError：回 failed、沒有扣次數
async def test_search_failure_refunds_and_restores(db_session): ...
    # default=ProviderError：回 failed、usage 回到 0、last_checked_at 還原
async def test_timeout_refunds_and_restores(db_session, monkeypatch): ...
    # INSTANT_TIMEOUT_SECONDS 改 0.01，provider.search 永遠等待
async def test_lost_claim_refunds(db_session): ...
    # 用 FakeProvider 的 on_remaining 先把 last_checked_at 設成今天：回 already_checked、次數退回
async def test_daily_job_skips_after_instant_check(db_session): ...
    # check_query 後跑 run_checks，search 只呼叫一次
async def test_sends_email_after_check(db_session): ...
    # 目標價高於價格時 FakeSender 收到一封
async def test_email_failure_keeps_result(db_session): ...
    # sender 丟任意 Exception（不只 EmailError）仍回 checked
```

`test_notifier.py` 加上：

```python
async def test_limit_stops_after_n(db_session): ...   # 3 封待寄、limit=2：寄 2 封，剩 1 封 pending
```

- [ ] **Step 2: 執行確認失敗**

Run：`uv run pytest tests/prices/test_instant.py tests/notifications/test_notifier.py -v`
Expected: 新測試 FAIL

- [ ] **Step 3: 實作**

步驟與順序照 spec〈流程〉。第 3、6 步共用 deadline：開頭算 `asyncio.get_running_loop().time() + INSTANT_TIMEOUT_SECONDS`，兩處都用 `asyncio.timeout_at(deadline)`，捕捉 `TimeoutError`。查詢 query 要用 `populate_existing`，避免讀到舊的 `last_checked_at`。寄信外層 `except Exception`，先 `session.rollback()` 再 `logger.exception`。不要捕捉 `record_result` 的例外（spec：回 500）。

- [ ] **Step 4: 執行確認通過**

Run：`uv run pytest tests/prices tests/notifications -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/app/modules backend/tests
git commit -m "feat: 新增立即查價的共用流程與寄信上限"
```

### Task 3: 兩個 API

**Files:**
- Create: `backend/app/modules/prices/deps.py`
- Modify: `backend/app/modules/prices/router.py`、`reference_router.py`、`schemas.py`
- Modify: `frontend/openapi.json`、`frontend/src/api/schema.d.ts`（腳本產生）
- Test: `backend/tests/prices/test_instant_api.py`

**Interfaces:**
- Consumes: Task 2 的 `check_watch`、`check_query`；`watches.service.validate_conditions`、`slots.acquire_watch_lock`、`slots.get_or_create_price_query`
- Produces:
  - `POST /api/v1/watches/{public_id}/check` → `InstantCheckOut { result }`
  - `POST /api/v1/price-reference/check`（body `QueryConditionsIn`）→ `PriceCheckOut { result, lowest_price, typical_low, typical_high }`
  - dependency `get_price_provider`（httpx client timeout 15 秒）、`get_sender`，測試用 `app.dependency_overrides` 換掉

- [ ] **Step 1: 寫失敗的測試**

```python
async def test_check_watch_returns_result(client, ...): ...      # 200、{"result": "checked"}
async def test_check_requires_auth(client): ...                  # 401
async def test_demo_cannot_check(client, ...): ...               # 兩個 API 都 403，calls 為空
async def test_other_users_watch_404(client, ...): ...
async def test_preview_returns_prices(client, ...): ...
    # insights 有區間：lowest_price=9000、typical_low、typical_high 都有值
async def test_preview_without_insights(client, ...): ...        # typical_* 是 null
async def test_preview_invalid_conditions_422(client, ...): ...  # 出發日過近，沒有扣次數
async def test_preview_shares_count_with_watch_check(client, ...): ...
    # 表單查 2 次不同條件 + 追蹤查 1 次後，第 4 次回 user_limit，lowest_price 是 null
async def test_preview_only_query_not_due_and_no_slot(client, db_session, ...): ...
    # due_queries 不含它；occupied_query_ids 不含它
async def test_preview_then_create_is_free(client, ...): ...
    # 表單查價 → 建立相同條件追蹤 → check 回 already_checked，search 只呼叫 1 次
async def test_preview_already_checked_uses_today_snapshot_only(client, db_session, ...): ...
    # 今天查過且有今天的 snapshot：回該價格；最新 snapshot 是昨天時 lowest_price 是 null
```

- [ ] **Step 2: 執行確認失敗**

Run：`uv run pytest tests/prices/test_instant_api.py -v`
Expected: FAIL，404 或 ImportError

- [ ] **Step 3: 實作路由並重新產生型別**

表單查價要先 commit 新建的 query 再呼叫 `check_query`，全站鎖才會放掉。`lowest_price` 用 `observed_at >= today_start(today)` 篩選。結果不是 `checked`、`no_result`、`already_checked` 時，價格欄位都回 null。

Run：`uv run python scripts/export_openapi.py`，再到 `frontend/` 執行 `npm run gen:api`

- [ ] **Step 4: 執行確認通過**

Run：`uv run pytest && uv run ruff check . && uv run mypy app`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add backend frontend/openapi.json frontend/src/api/schema.d.ts
git commit -m "feat: 新增立即查價與表單查價 API"
```

### Task 4: 前端立即查價與修改警告

**Files:**
- Modify: `frontend/src/api/queries.ts`、`frontend/src/lib/watchForm.ts`
- Modify: `frontend/src/pages/WatchFormPage.tsx`、`WatchDetailPage.tsx`
- Test: `frontend/src/lib/watchForm.test.ts`、`frontend/src/pages/WatchFormPage.test.tsx`、`WatchDetailPage.test.tsx`

**Interfaces:**
- Consumes: Task 3 的 `POST /api/v1/watches/{public_id}/check`
- Produces:
  - `useCheckWatch()`：`mutationKey: ["check"]`、`mutationFn(id: string)`、`meta: { silent: true }`；`onSettled` 讓 `keys.watch(id)` 與 `keys.notifications` 失效（寫在 hook 的選項裡，表單卸載後仍會執行）
  - `changesConditions(body: WatchUpdate): boolean`

- [ ] **Step 1: 寫失敗的測試**

```ts
it("新增後發一次查價請求"); it("排隊中不發查價請求");
it("改條件後發一次；只改目標價不發");
it("改條件且不是暫停中時跳一個含「最多消耗今天 3 次中的 1 次」的確認視窗，取消後不送出");
it("只改目標價、暫停中改條件都維持原本的確認文字");
it("changesConditions：target_price 回 false，其他條件欄位回 true");
it("查價中顯示「查價中…」，完成後重新載入價格");
it.each(各 result)("詳情頁顯示 spec 表格的對應文字");
it("查價請求斷線：追蹤正常顯示，只有「查價暫時失敗，明天 08:00 會再試」，沒有全域錯誤提示");
it("直接打開或重新整理詳情頁不發查價請求");
```

- [ ] **Step 2: 執行確認失敗**

Run（`frontend/`）：`npx vitest run src/lib/watchForm.test.ts src/pages/WatchFormPage.test.tsx src/pages/WatchDetailPage.test.tsx`
Expected: 新測試 FAIL

- [ ] **Step 3: 實作**

表單在 `mutate` 後不等待，直接 `navigate`。詳情頁新增 `CheckStatus`：用 `useMutationState({ filters: { mutationKey: ["check"], predicate: (m) => m.state.variables === id } })`，取最後一筆。文字照 spec 的表格。

- [ ] **Step 4: 執行確認通過**

Run：`npm run test && npm run lint && npm run typecheck`
Expected: 全部通過

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat: 建立或修改追蹤後立即查價，修改前先警告"
```

### Task 5: 前端表單查價與典型低價

**Files:**
- Modify: `frontend/src/api/queries.ts`、`frontend/src/pages/WatchFormPage.tsx`
- Test: `frontend/src/pages/WatchFormPage.test.tsx`

**Interfaces:**
- Consumes: Task 3 的 `POST /api/v1/price-reference/check`；`referenceConditions(values)` 的結果直接當 body（單程沒有 `return_date`，後端預設 null）
- Produces: `useCheckPriceReference()`（`meta: { silent: true }`，完成後讓 `["price-reference"]` 與 `keys.notifications` 失效）

- [ ] **Step 1: 寫失敗的測試**

```ts
it("條件不完整時按鈕停用；示範帳號停用");
it("按下後顯示目前最低與典型價格，並隱藏原本的參考價提示");
it("沒有區間時只顯示最低價，沒有快速選項");
it("lowest_price 是 null 且有區間時顯示「目前查不到航班｜典型價格…」");
it("點「典型低價 NT$8,200」把 8200 填進目標價");
it("改條件後結果消失，按鈕可再按");
it("查價進行中改條件：回來的舊結果不顯示");
it("進行中按鈕停用，連按只發一個請求");
it("user_limit 顯示提示，按鈕在這次填表期間停用，表單仍可送出");
it("site_limit、quota_exhausted、failed 各自的文字；failed 可再按");
it("回 422 時顯示後端訊息");
```

- [ ] **Step 2: 執行確認失敗**

Run：`npx vitest run src/pages/WatchFormPage.test.tsx`
Expected: 新測試 FAIL

- [ ] **Step 3: 實作 `PriceCheck` 元件（放在 `WatchFormPage.tsx`）**

結果和發出時的條件一起存：`{ key: JSON.stringify(cond), data }`，只有 `key` 等於目前條件才顯示，不用 effect 清除。按鈕用 `WriteButton`，`type="button"`。放在 `PriceReferenceHint` 的位置；有結果時不渲染 `PriceReferenceHint`。錯誤用 `ApiError` 的 status 判斷：422 用 `errorMessage(err)`，其他用失敗文字。

- [ ] **Step 4: 執行確認通過**

Run：`npm run test && npm run lint && npm run typecheck && npm run build`
Expected: 全部通過

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat: 表單可查目前價格並用典型低價填入目標價"
```

### Task 6: 權限、文件與上線

**Files:**
- Modify: `infra/terraform/ses.tf`
- Modify: `docs/01-requirements.md`、`docs/02-design.md`、`docs/04-testing.md`、`CLAUDE.md`

**Interfaces:**
- Consumes: Task 1～5 全部

- [ ] **Step 1: 加 `aws_iam_role_policy.api_send_email`（role 是 `aws_iam_role.api`），更新「只有 jobs Lambda 會寄信」的註解**

Run：`terraform -chdir=infra/terraform fmt -check && terraform -chdir=infra/terraform validate`
Expected: `Success!`

- [ ] **Step 2: 依 spec〈文件更新〉更新文件，commit**

```bash
git add infra/terraform/ses.tf docs CLAUDE.md
git commit -m "feat: API Lambda 加寄信權限並更新文件"
```

- [ ] **Step 3: push、由使用者開 PR、CI 全綠後合併**

- [ ] **Step 4: 使用者同意後，依 runbook 第 5 節部署**

順序：直連網址跑 `uv run python -m alembic upgrade head`（機密由使用者輸入）→ `push-image.sh` → `terraform plan`，確認只新增 1 個 policy、更新 2 個 Lambda 的 image → `apply` → `deploy-frontend.sh`

Expected: `curl https://hao007186.com/api/v1/health` 回 `{"status":"ok"}`

- [ ] **Step 5: 使用者同意花 2 次額度後，照 spec〈完成標準〉實測**

Expected: 詳情頁出現價格、鈴鐺和信箱當下收到通知；表單查價後建立追蹤不再花額度（CloudWatch log 與 `api_usage` 確認）
