# 目標價參考價 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal：** 新增／編輯追蹤表單填好查價條件後，在目標價下方顯示資料庫裡完全相同條件的 Google 典型價格區間；沒有資料就顯示提示。不花 SerpApi 額度。

**Architecture：** 後端在 prices 模組加一支 `GET /api/v1/price-reference`，用和建立追蹤相同的 `QueryConditions.query_hash()` 找 `price_queries`，再讀 `price_baselines`，只回三個欄位。前端用 `referenceConditions()` 判斷條件是否完整，`usePriceReference()` 查詢，`WatchFormPage` 顯示一行灰字。

**Tech Stack：** FastAPI（query 參數 model）、SQLAlchemy async、pytest；React 19、TanStack Query、openapi-fetch、vitest + MSW 3。

**Spec：** [docs/superpowers/specs/2026-10-26-m1-price-reference-design.md](../specs/2026-10-26-m1-price-reference-design.md)

## Global Constraints
- 不呼叫 PriceProvider、不寫入任何資料表（純讀取）
- 回應只有 `typical_low`、`typical_high`、`updated_at` 三個欄位；不回 `record_low`、目標價、追蹤 ID
- `is_demo` 一律取自 `user.is_demo`，不接受參數
- 查不到時回 200，三個欄位都是 null；`typical_low` 為 null 時也視為查不到
- 文件、註解、畫面文字用繁體中文；commit 用 Conventional Commits，結尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 改了 API 要重新產生 `frontend/openapi.json`（`uv run python scripts/export_openapi.py`）和 `src/api/schema.d.ts`（`npm run gen:api`），CI 會 diff 這兩個檔案
- 本機 Node 在 `C:\Program Files\nodejs`，shell 的 PATH 可能沒有，要自己加

## Review Focus
1. 填完來回的回程日後切成單程：參考價要用單程條件查（不帶 `return_date`），不能沿用舊的回程日 → Task 2 的 `referenceConditions` 測試
2. 出發地和目的地相同：前端不發請求（否則後端回 422 會被當成錯誤）→ Task 2 測試
3. 編輯一筆快出發、日期已經不在可新增範圍內的追蹤：仍要顯示自己這筆的參考價（後端不檢查日期範圍）→ Task 1 測試「過去日期也能查」
4. 既有的表單測試沒有假造 `/price-reference`，加上查詢後會因為「未處理的請求」而失敗 → Task 3 在 `mockCommon` 加預設 handler（回三個 null）
5. 示範帳號打開新增表單也會呼叫這支 API，要回 200 而不是 403 → Task 1 測試

---

### Task 1: 後端 `GET /price-reference`

**Files:**
- Modify: `backend/app/modules/watches/schemas.py`（拆出 `QueryConditionsIn`）
- Modify: `backend/app/modules/prices/schemas.py`（加 `PriceReferenceOut`）
- Create: `backend/app/modules/prices/reference_router.py`
- Modify: `backend/app/main.py`（掛上新 router）
- Test: `backend/tests/prices/test_reference_api.py`
- Modify: `frontend/openapi.json`（腳本產生）
- Modify: `docs/02-design.md`（〈API 草案〉）

**Interfaces:**
- Produces：
  - `class QueryConditionsIn(BaseModel)`：`origin`、`destination`、`depart_date`、`return_date`、`cabin`、`adults`、`airlines`，連同既有的 validator 與 `_consistent` 一起從 `WatchCreate` 搬過來；`class WatchCreate(QueryConditionsIn)` 只多 `target_price`
  - `class PriceReferenceOut(BaseModel)`：`typical_low: int | None`、`typical_high: int | None`、`updated_at: datetime | None`
  - `GET /api/v1/price-reference`，query 參數同 `QueryConditionsIn`，`airlines` 用重複參數（`airlines=BR&airlines=CI`）
  - OpenAPI operation 產生的前端路徑：`"/api/v1/price-reference"`

- [ ] **Step 1: 寫失敗的測試** `tests/prices/test_reference_api.py`

佈置用 `tests.prices.conftest` 的 `auth_headers`、`demo_headers`、`insert_watch`、`TODAY`；baseline 直接 `db_session.add(PriceBaseline(price_query_id=watch.price_query_id, typical_low=6400, typical_high=12500, record_low=5000, history_seeded=True, sample_count=1))` 後 flush。`insert_watch` 的預設條件是 TPE→NRT、出發日 `TODAY + 30 天`、單程、economy、1 人、全部航空公司。

URL 常數 `"/api/v1/price-reference"`，預設參數 `{"origin": "TPE", "destination": "NRT", "depart_date": (TODAY + timedelta(days=30)).isoformat()}`。

```python
async def test_hit(...):            # 回傳 == {"typical_low": 6400, "typical_high": 12500, "updated_at": <非 None>}
                                    # 並且 set(body) == {"typical_low", "typical_high", "updated_at"}
async def test_other_users_query(...):  # alice 的 watch + baseline，bob 查得到同樣的區間
async def test_miss_no_query(...):  # destination=KIX → 三個 null
async def test_miss_no_baseline(...):   # 有 watch 沒 baseline → 三個 null
async def test_miss_no_typical(...):    # baseline typical_low/high 都是 None、record_low=5000 → 三個 null
async def test_airlines_normalized(...):  # watch 佈置 airlines=("BR", "CI")；
                                          # 參數 [("airlines", "ci"), ("airlines", "BR")] → 命中
async def test_round_trip(...):     # watch 佈置 return_date=TODAY+35；不帶 return_date → 三個 null；帶 → 命中
async def test_past_dates_ok(...):  # watch 佈置 depart_date=TODAY-5；查同條件 → 命中（不檢查日期範圍）
async def test_demo_isolation(...): # 一般帳號的 watch+baseline：demo_headers 查 → null
                                    # 示範帳號 (ensure_demo_user) 的 is_demo=True watch+baseline：
                                    # 一般帳號查 → null、demo_headers 查 → 命中且 status 200
async def test_requires_login(...): # 無 headers → 401
async def test_invalid(...):        # destination=TPE → 422；return_date 早於 depart_date → 422
```

- [ ] **Step 2: 執行，確認失敗**

Run（在 `backend/`）：`uv run pytest tests/prices/test_reference_api.py -v`
Expected：全部 FAIL，回應是 404（路由不存在）

- [ ] **Step 3: 實作**
  - `watches/schemas.py`：拆出 `QueryConditionsIn`（見 Interfaces），`WatchCreate` 改為繼承它
  - `prices/schemas.py`：加 `PriceReferenceOut`
  - `prices/reference_router.py`：`router = APIRouter(tags=["prices"])`；`@router.get("/price-reference") async def get_price_reference(cond: Annotated[QueryConditionsIn, Query()], user: CurrentUser, session: SessionDep) -> PriceReferenceOut`。用 `QueryConditions(..., airlines=tuple(cond.airlines), is_demo=user.is_demo).query_hash()` 查 `PriceQuery`，再 `session.get(PriceBaseline, query.id)`；沒有 query、沒有 baseline 或 `typical_low is None` 時回三個 None
  - `main.py`：`app.include_router(reference_router.router, prefix=API_PREFIX)`。注意 `main.py` 已經有一個叫 `reference_router` 的 import（機場／航空公司），新的 import 要取別名，例如 `from app.modules.prices import reference_router as price_reference_router`

- [ ] **Step 4: 執行，確認通過；既有測試也要過**

Run：`uv run pytest tests/prices/test_reference_api.py tests/watches -v`，再跑 `uv run pytest`、`uv run ruff check .`、`uv run ruff format --check .`、`uv run mypy app`
Expected：全部 PASS，沒有 lint／型別錯誤

- [ ] **Step 5: 重新產生 openapi.json 並更新文件**

Run：`uv run python scripts/export_openapi.py`
Expected：`frontend/openapi.json` 多了 `/api/v1/price-reference`、`PriceReferenceOut`；`WatchCreate` 的欄位不變（可能多出 `QueryConditionsIn` schema，沒關係）

`docs/02-design.md`〈API 草案〉的 Watches 那一行後面加：`、GET /price-reference（新增／編輯表單的參考價：完全相同條件的典型價格區間，不花額度）`

- [ ] **Step 6: Commit**

```bash
git add backend frontend/openapi.json docs/02-design.md
git commit -m "feat: 依查價條件查典型價格區間的 API"
```

---

### Task 2: 前端 `referenceConditions` 與 `usePriceReference`

**Files:**
- Modify: `frontend/src/api/schema.d.ts`（`npm run gen:api` 產生）
- Modify: `frontend/src/lib/watchForm.ts`
- Test: `frontend/src/lib/watchForm.test.ts`（已存在就加在裡面，沒有就新建）
- Modify: `frontend/src/api/queries.ts`

**Interfaces:**
- Consumes：Task 1 的 `"/api/v1/price-reference"` 與 `PriceReferenceOut`
- Produces：
  - `type ReferenceConditions = { origin: string; destination: string; depart_date: string; return_date?: string; cabin: Cabin; adults: number; airlines: string[] }`（`watchForm.ts` export）
  - `referenceConditions(v: WatchFormValues): ReferenceConditions | null`
  - `type PriceReference = components["schemas"]["PriceReferenceOut"]`（`queries.ts` export）
  - `usePriceReference(cond: ReferenceConditions | null)`：TanStack `useQuery`，key `["price-reference", cond]`，`enabled: cond !== null`，`staleTime: 5 * 60_000`，`meta: { silent: true }`（失敗不跳全域提示）

- [ ] **Step 1: 產生型別**

Run（在 `frontend/`）：`npm run gen:api`
Expected：`src/api/schema.d.ts` 出現 `"/api/v1/price-reference"` 和 `PriceReferenceOut`

- [ ] **Step 2: 寫失敗的測試**（`referenceConditions`）

```ts
// base = { ...emptyForm(), destination: "NRT", departDate: "2026-12-20", returnDate: "2026-12-25" }
it("來回條件完整時回傳條件", () =>
  expect(referenceConditions(base)).toEqual({ origin: "TPE", destination: "NRT",
    depart_date: "2026-12-20", return_date: "2026-12-25", cabin: "economy", adults: 1, airlines: [] }));
it("單程不帶回程日，即使欄位還留著舊值", () =>
  expect(referenceConditions({ ...base, tripType: "one_way" })).not.toHaveProperty("return_date"));
it("缺目的地回 null", ...)          // destination: ""
it("出發地等於目的地回 null", ...)   // destination: "TPE"
it("缺出發日回 null", ...)          // departDate: ""
it("來回缺回程日回 null", ...)       // returnDate: ""
it("回程早於出發回 null", ...)       // returnDate: "2026-12-19"
it("目標價沒填也照樣回傳條件", ...)   // targetPrice: ""（參考價就是給還沒填目標價的人看的）
```

- [ ] **Step 3: 執行，確認失敗**

Run：`npx vitest run src/lib/watchForm.test.ts`
Expected：FAIL，`referenceConditions` 不存在

- [ ] **Step 4: 實作** `referenceConditions` 與 `usePriceReference`（簽名見 Interfaces）

`usePriceReference` 的 queryFn：`unwrap(await api.GET("/api/v1/price-reference", { params: { query: cond! } }))`。openapi-fetch 預設把陣列序列化成重複參數，符合後端。

- [ ] **Step 5: 執行，確認通過**

Run：`npx vitest run src/lib/watchForm.test.ts`、`npm run typecheck`、`npm run lint`
Expected：PASS，沒有型別或 lint 錯誤

- [ ] **Step 6: Commit**

```bash
git add frontend/src
git commit -m "feat: 前端判斷參考價條件與查詢 hook"
```

---

### Task 3: 表單顯示參考價

**Files:**
- Modify: `frontend/src/lib/format.ts`（加 `formatMonthDay`）
- Modify: `frontend/src/pages/WatchFormPage.tsx`
- Modify: `frontend/src/test/data.ts`（`mockCommon` 加預設 handler）
- Test: `frontend/src/pages/WatchFormPage.test.tsx`、`frontend/src/lib/format.test.ts`（已存在就加，沒有就新建）
- Modify: `docs/02-design.md`（〈前端頁面〉）、`docs/04-testing.md`

**Interfaces:**
- Consumes：Task 2 的 `referenceConditions`、`usePriceReference`、`PriceReference`
- Produces：`formatMonthDay(iso: string): string`（台灣時間 `M/D`，不補零，例如 `"10/20"`）；`WatchFormPage.tsx` 內部元件 `PriceReferenceHint({ values, editing }: { values: WatchFormValues; editing: boolean })`

**畫面文字（照抄）：**
- 有區間：`同條件的典型價格：${formatPrice(low)}～${formatPrice(high)}（${formatMonthDay(updated_at)} 更新）`，例如「同條件的典型價格：NT$ 8,200～NT$ 11,500（10/20 更新）」（spec 寫的是 `NT$8,200～11,500`，這裡沿用既有的 `formatPrice`，兩端都帶 NT$）
- 沒資料、新增：`這個行程還沒有價格資料，建立後第一次查價就會顯示，之後可以再調整目標價`
- 沒資料、編輯：`這個行程還沒有價格資料，儲存後第一次查價就會顯示，之後可以再調整目標價`
- 條件不完整、載入中、請求失敗：不顯示任何東西
- 樣式：`mt-1 text-xs text-slate-500`，放在目標價 `Field` 的 input 下方（錯誤訊息上方或下方都可以，跟著 `Field` 的 children 放）

- [ ] **Step 1: `mockCommon` 加預設 handler**

`http.get("/api/v1/price-reference", () => HttpResponse.json({ typical_low: null, typical_high: null, updated_at: null }))`。先跑一次 `npx vitest run`，確認既有測試仍全部通過（這一步只加 mock，畫面還沒用到）。

- [ ] **Step 2: 寫失敗的測試**

`format.test.ts`：`formatMonthDay("2026-10-19T16:30:00Z")` 是 `"10/20"`（跨日到台灣時間）。

`WatchFormPage.test.tsx` 新增 `describe("參考價", ...)`，用既有的 `fillValid()`、`mockGetWatch`、`makeWatch`：

```ts
it("有資料時顯示區間與更新日期")
  // server.use 回 { typical_low: 8200, typical_high: 11500, updated_at: "2026-10-20T01:00:00Z" }
  // 填好目的地與日期 → findByText("同條件的典型價格：NT$ 8,200～NT$ 11,500（10/20 更新）")
it("查詢參數帶上表單條件")
  // 記錄 request.url 的 searchParams；勾一家航空公司後 getAll("airlines") 包含該代碼、return_date === RETURN
it("新增時沒資料顯示建立後的提示")    // mockCommon 預設 → findByText(/建立後第一次查價就會顯示/)
it("編輯時沒資料顯示儲存後的提示")    // mockGetWatch(makeWatch()) + 預設 → /儲存後第一次查價就會顯示/
it("條件不完整時不發請求")
  // 計數 handler；renderApp("/watches/new") 等機場載入後只選目的地 → 等 50ms，次數為 0，且畫面沒有「典型價格」或「還沒有價格資料」
it("請求失敗時不顯示")
  // 回 500；填好條件 → 等請求發出後，queryByText(/典型價格|還沒有價格資料/) 為 null，且沒有全域錯誤提示
```

- [ ] **Step 3: 執行，確認失敗**

Run：`npx vitest run src/pages/WatchFormPage.test.tsx src/lib/format.test.ts`
Expected：新測試 FAIL（找不到文字、`formatMonthDay` 不存在）；既有測試 PASS

- [ ] **Step 4: 實作** `formatMonthDay` 與 `PriceReferenceHint`，在 `WatchForm` 的目標價 `Field` 內放 `<PriceReferenceHint values={values} editing={original !== undefined} />`

`typical_low` 和 `typical_high` 都不是 null 才算有資料。

- [ ] **Step 5: 執行全部前端檢查**

Run：`npm test`、`npm run typecheck`、`npm run lint`、`npm run build`
Expected：全部通過（build 的 >500KB 警告是既有的，可忽略）

- [ ] **Step 6: 更新文件**
  - `docs/02-design.md`〈前端頁面〉加一段：`**目標價參考價：** 新增／編輯表單填好查價條件後，若資料庫已有完全相同條件的典型價格區間就顯示在目標價下方，沒有就提示第一次查價後會顯示；不花查價額度。細節見 [目標價參考價設計](superpowers/specs/2026-10-26-m1-price-reference-design.md)。`
  - `docs/04-testing.md`：在後端 API 測試與前端測試的清單各補一項（後端：參考價命中／查不到／示範資料隔離／航空公司順序；前端：參考價條件判斷、顯示區間或提示、條件不完整不查詢）

- [ ] **Step 7: Commit**

```bash
git add frontend/src docs
git commit -m "feat: 新增與編輯追蹤表單顯示目標價參考價"
```

---

### 收尾
- [ ] 在 python:3.14-slim 容器跑一次後端 pytest（本機是 Windows、CI 是 Linux：`UV_PROJECT_ENVIRONMENT=/tmp/venv`、刪掉複製進去的 `.env`、`TEST_DATABASE_URL` 連 `host.docker.internal`）
- [ ] 本機走一次：`docker compose up`、前端 `npm run dev`，用示範帳號打開示範追蹤的編輯頁看得到區間；新增表單選一個沒人追蹤的行程看到提示
- [ ] 最後一次整個分支的審查，然後 push、提供 compare 網址與 PR 說明
