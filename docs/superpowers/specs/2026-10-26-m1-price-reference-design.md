# M1 小子專案：目標價參考價 — 設計

日期：2026-10-26
狀態：待審閱
相關文件：[architecture.md](../../architecture.md)、[02-design.md](../../02-design.md)、[#4 查價設計](2026-10-23-m1-prices-design.md)、[#6 前端設計](2026-10-25-m1-frontend-design.md)

## 背景與目標
設定目標價時沒有任何參考，不知道該填多少。原本想顯示「去年同期的最低／最高價」，但拿不到去年的資料（SerpApi 的 `price_history` 只有約 60 天、自己的資料庫才剛開始累積），在表單當場查價又會吃掉每月 250 次的額度。

折衷做法：新增／編輯追蹤表單填好查價條件後，如果資料庫已經有**完全相同查價條件**的 `price_baselines`，就在目標價欄位下方顯示 Google 的典型價格區間（`typical_low`～`typical_high`）；沒有就提示建立後第一次查價就會顯示。**不花 SerpApi 額度。**

**完成標準：**
- 下方〈測試〉列出的案例全部通過
- 本機用示範資料走一次：編輯示範追蹤時看得到典型區間；新增一個沒人追蹤過的行程時看到提示文字
- PR 上的 CI 全綠

## 不在範圍內
- 條件相近（例如出發日前後幾天）的參考價：使用者選擇只比對完全相同的條件，因為 Google 的典型區間本來就是針對那組日期與條件
- 表單當場花額度查價（B 方案，不採用）
- 用自己累積一年的資料顯示去年同期（C 方案，之後的擴充）
- 自動把參考價填進目標價欄位

## 設計決定
| 項目 | 決定 | 理由 |
|---|---|---|
| 比對方式 | 只比對完全相同的查價條件（同一個 `query_hash`） | 數字最準；資料庫已有這組條件的雜湊，查詢只要一次 index lookup |
| API 形狀 | 新的 `GET /price-reference`，條件放在網址參數 | 新增與編輯表單都能用；不需要先有追蹤。只讀不寫，所以用 GET |
| 查不到時 | 回 200，三個欄位都是 null | 「還沒有資料」是正常情況，不是錯誤；前端不用特別處理 404 |
| 示範資料隔離 | `is_demo` 取自目前登入的帳號，不由參數決定 | 和建立追蹤相同；示範帳號只查得到示範資料，一般帳號也查不到示範資料 |
| 回傳內容 | 只有 `typical_low`、`typical_high`、`updated_at` | 不洩漏目標價、追蹤 ID、追蹤人數。查得到區間代表「有人追蹤過完全一樣的行程」，但區間本身是 Google 的公開資料、使用者也很少，可以接受 |
| 附上更新時間 | 回傳 `price_baselines.updated_at` | 已停止查價的條件，區間可能是很久以前的資料，讓使用者自己判斷 |
| 不回 `record_low` | 不回 | `record_low` 混合了自己的查價紀錄，不是公開資料；參考價只需要典型區間 |

## 後端

### 共用的查價條件 schema（`app/modules/watches/schemas.py`）
把 `WatchCreate` 中除了 `target_price` 以外的欄位與檢查拆成 `QueryConditionsIn`，`WatchCreate` 繼承它再加上 `target_price`。檢查規則不變：機場代碼 3 碼並轉大寫、航空公司代碼轉大寫去重排序、出發地 ≠ 目的地、回程日不早於出發日、人數 1～9。

機場代碼不存在、日期已過都**不另外檢查**，只是查不到資料。

### API（`app/modules/prices/`）
`GET /api/v1/price-reference?origin=TPE&destination=NRT&depart_date=2026-12-20&return_date=2026-12-25&cabin=economy&adults=1&airlines=BR&airlines=CI`

- 需要登入（`CurrentUser`）；示範帳號也可以呼叫（只讀）
- `airlines` 用重複的參數表示多個；不帶表示全部航空公司
- 參數用 `QueryConditionsIn` 檢查，不合法回 422
- 流程：組出 `QueryConditions(..., is_demo=user.is_demo)` → 算 `query_hash()` → 用雜湊找 `price_queries` → 用 id 找 `price_baselines`
- 回應 `PriceReferenceOut`：

```json
{ "typical_low": 8200, "typical_high": 11500, "updated_at": "2026-10-20T01:00:00Z" }
```

  找不到 `price_queries`、找不到 `price_baselines`、或 baseline 還沒有典型區間（`typical_low` 為 null）時，三個欄位都回 null。

放在 prices 模組的新 router（prefix 不是 `/watches`），在 `app/main.py` 掛上。

## 前端

### 資料取得（`src/api/queries.ts`）
新增 `usePriceReference(conditions | null)`：
- 傳入 null 時不發請求（react-query 的 `enabled: false`）
- query key 包含所有條件，條件一改就重新查
- 重新產生 openapi 型別

`src/lib/watchForm.ts` 新增 `referenceConditions(values)`：表單條件完整時回傳條件，否則回 null。完整的定義：目的地已選、出發地 ≠ 目的地、出發日已填，來回行程還要填回程日且不早於出發日。

### 顯示（`WatchFormPage`）
目標價欄位下方一行灰色小字：

| 狀態 | 顯示 |
|---|---|
| 條件不完整 | 不顯示 |
| 載入中 | 不顯示（避免閃爍） |
| 有區間 | 「同條件的典型價格：NT$8,200～11,500（10/20 更新）」 |
| 沒有資料 | 新增：「這個行程還沒有價格資料，建立後第一次查價就會顯示，之後可以再調整目標價」；編輯：「儲存」取代「建立」 |
| 請求失敗 | 不顯示（只是輔助資訊，不干擾填表） |

日期用台灣時間的 M/D，金額用既有的格式化函式。

## 測試
**後端（pytest）**
- 已有 baseline 的條件 → 回傳區間與 `updated_at`
- 沒有這組條件、有條件但沒有 baseline、baseline 沒有典型區間 → 三個欄位都是 null
- 航空公司順序、大小寫不同也能命中
- 示範帳號查不到一般資料；一般帳號查不到示範資料
- 沒登入 → 401；出發地等於目的地、回程早於出發 → 422
- 回應只有三個欄位
- `WatchCreate` 既有測試繼續通過（拆 schema 不改行為）

**前端（vitest + MSW）**
- `referenceConditions`：單程／來回、缺目的地、缺回程日、回程早於出發
- 有區間時顯示區間與更新日期
- 沒資料時新增與編輯各自顯示正確的提示
- 條件不完整時不發請求
- 請求失敗時不顯示任何參考價文字

## 文件更新
- `docs/02-design.md`〈API 草案〉加上 `GET /price-reference`
- `docs/02-design.md`〈前端頁面〉加一句新增／編輯表單會顯示參考價
- `docs/04-testing.md` 補上對應測試項目
