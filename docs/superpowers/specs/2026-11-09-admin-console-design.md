# 後台（管理帳號、追蹤與用量）設計

日期：2026-11-09　分支：`feat/admin-console`

## 為什麼要做
網站要對外展示，但目前沒有任何管理功能。註冊不用驗證信箱，每人最多 3 個追蹤，全站同時最多 8 組查價條件；只要 3 個帳號就能把名額佔滿，正常使用者的追蹤會一直排隊，立即查價也會沒有次數可用。現在出事時只能直接改正式資料庫。

這個子專案讓維護者（目前只有專案作者本人）有一個後台：
1. **出事後處理**：刪除任何人的追蹤、停用帳號（同時刪掉他的追蹤），名額會自動補位
2. **及早發現**：需求 US-10「查看 API 額度用量和通知發送量」，在 M1 期間延後未做，這次一起做

## 目標
- admin 可以看到全站帳號、佔名額的追蹤，以及用量數字
- admin 可以刪除任何人的追蹤、停用帳號、恢復帳號
- 一般使用者完全看不到、也用不了這些功能

## 不做（non-goals）
- 操作紀錄（刪了就刪了）
- 在後台把別人設成 admin；admin 由維護者在資料庫手動設定
- 編輯別人的追蹤、修改別人的密碼或 Email
- 搜尋、分頁、排序切換（使用者很少，全部列出）
- 通知被刪除追蹤的主人
- 手機版排版（跟現有前端一樣以電腦為主，但不能壞掉）
- 防止惡意註冊（信箱驗證、註冊頻率限制、保留名額），之後另外評估
- 新增資料庫欄位或資料表

## 不能發生的事（anti-goals）
- 一般使用者能呼叫任何 admin API，或在畫面上看到後台入口
- 刪除或停用之後名額沒有釋放、排隊的追蹤沒有補位
- admin 把自己或示範帳號停用
- 後台打開時花掉 SerpApi 額度（查剩餘額度的 `account.json` 不扣額度，可以用）
- SerpApi 故障時整個後台打不開

## 做法（Approaches）
資料庫裡沒有「每天呼叫 SerpApi 幾次」的紀錄（`api_usage` 只記每月總數），「今天用量」要決定怎麼算：

| | A. 用現有資料推算（**採用**） | B. 新增每日呼叫紀錄 |
|---|---|---|
| 做法 | 從 `price_queries.last_checked_at` 和 `instant_check_usage` 算 | 每次呼叫 SerpApi 時多記一筆當天次數 |
| 資料庫 | 不用改 | 要 migration |
| 準確度 | 查價失敗、查不到航班也會扣 SerpApi 額度，但不算「查過」，可能少算 | 精確 |

使用者選 A：最準的數字是即時查到的「SerpApi 本月剩餘額度」，今天用量只是用來看出異常，大致準確就夠。

其他部分只有一種合理做法：後端新增 `admin` 模組（`/api/v1/admin/...`），前端在現有網站加 `/admin` 頁面。另做一個後台網站要多一套部署，對單人專案不划算。

## 已決定的設計

### 權限
- admin = `users.role == 'admin'`（欄位已存在）。維護者部署後在 Neon SQL Editor 執行一次：
  `UPDATE users SET role = 'admin' WHERE email = '<維護者的 Email>';`
  （寫進 `docs/deploy-runbook.md`）
- 後端新增 `require_admin` dependency，放在 `auth/deps.py`，寫法比照 `require_writable_user`：先經過 `get_current_user`（已檢查 `is_active`），`role != 'admin'` 回 **403**
- 所有 `/api/v1/admin/*` 都要 `require_admin`
- 前端 `/me` 已經回傳 `role`。`role === 'admin'` 時，導覽列（電腦版和手機版選單）多一個「後台」連結；非 admin 打開 `/admin` 顯示現有的「找不到頁面」

### 停用帳號
- 只能停用：非 admin、非示範帳號、目前是啟用中的帳號。admin 對自己、對示範帳號、對其他 admin 操作都回 **409**（訊息說明原因）
- 在同一個 transaction 裡：取得名額全站鎖（`slots.acquire_watch_lock`）→ `is_active = false` → **刪除他所有的追蹤**（不分狀態）→ 刪除他所有的 refresh token → `slots.rebalance` → commit
- 已登入的分頁會在下一次 API 請求時被登出（`get_current_user` 每次都查 `is_active`）
- 帳號本身、站內通知、通知設定都保留；Email 仍被佔用，不能用同一個 Email 重新註冊
- 對已停用的帳號再停用：回 409

### 恢復帳號
- `is_active = true`，對方可以用原本的 Email 和密碼登入；追蹤不會回來
- 對啟用中的帳號恢復：回 409

### 刪除單一追蹤
- 可以刪任何人的追蹤（示範帳號的追蹤除外，回 409，避免展示內容被刪掉）
- 沿用 `watches/service.py` 的 `delete_watch` 流程（全站鎖 → 刪除 → 補位 → commit），只是查找追蹤時不限擁有者。實作時把「找到追蹤後刪除並補位」抽成共用函式，不要複製一份
- 刪除後連帶刪掉該追蹤的 alerts 與寄信紀錄（資料庫已設 `ON DELETE CASCADE`），因此「本月寄信量」會跟著變少，可以接受
- 追蹤不存在：404

### API
全部在 `/api/v1/admin` 底下，回傳欄位對外一律用 `public_id`，不露出流水號 id。

| 方法與路徑 | 內容 |
|---|---|
| `GET /admin/users` | 全部帳號，依註冊時間新到舊。每筆：`public_id`、`email`、`display_name`、`role`、`is_demo`、`is_active`、`created_at`、`slot_count`（狀態是 active 或 queued 的追蹤數） |
| `POST /admin/users/{public_id}/deactivate` | 停用，回傳更新後的帳號 |
| `POST /admin/users/{public_id}/reactivate` | 恢復，回傳更新後的帳號 |
| `GET /admin/watches` | 狀態是 `active` 或 `queued`、且不是示範資料的追蹤，依建立時間舊到新（跟排隊補位的順序一致）。每筆：`public_id`、擁有者 `email`、`origin`、`destination`、`depart_date`、`return_date`、`status`、`created_at` |
| `DELETE /admin/watches/{public_id}` | 刪除，回 204 |
| `GET /admin/usage` | 用量，見下一節 |

### 用量（`GET /admin/usage`）
「今天」與「本月」一律用台灣時間（沿用 `app.core.clock` 與 `checker.today_start`、`usage_month`）。

| 欄位 | 算法 |
|---|---|
| `serpapi_remaining` | 即時呼叫 `provider.remaining_quota()`（沿用 `prices/deps.py` 的 `ProviderDep`）。失敗（`ProviderError`、逾時）或來源不回報時為 `null`，其他欄位照常回傳 |
| `daily_budget` | `serpapi_remaining` 有值時 `budget.daily_budget(serpapi_remaining, today)`，否則 `null`。畫面註明「依目前剩餘額度計算」 |
| `month_calls` | `api_usage` 本月、目前 provider 的 `count`，沒有資料為 0 |
| `checked_today` | 非示範的 `price_queries` 中 `last_checked_at >= today_start(today)` 的數量（排程和立即查價都算） |
| `instant_today` | `instant_check_usage` 今天的 `count` 加總（失敗時已退回，所以是成功次數） |
| `instant_remaining` | `daily_budget` 有值時 `max(0, daily_budget − 佔名額的條件數 − instant_today)`，否則 `null`。公式與 `prices/instant.py` 判斷全站上限的方式一致 |
| `slots_used`、`slots_max`、`queued` | `len(slots.occupied_query_ids(today))`、`slots.MAX_ACTIVE_QUERIES`、狀態是 queued 的非示範追蹤數 |
| `email_sent`、`email_failed`、`email_pending` | `alert_deliveries` 中 `created_at` 在本月、`channel = 'email'` 的各狀態數量（`skipped` 不顯示） |

### 前端
- 新頁面 `/admin`（`AdminPage`），放在 `RequireAuth` + `Layout` 底下；非 admin 顯示 `NotFoundPage`
- 一頁三個區塊，由上到下：**用量**、**帳號**、**追蹤**

```
後台
┌─ 用量 ─────────────────────────────────────────┐
│ SerpApi 本月剩餘   180 次                        │
│ 今天預算            9 次（依目前剩餘額度計算）    │
│ 今天已查價          7 組條件，其中立即查價 2 次   │
│ 立即查價剩餘        0 次                         │
│ 本月已呼叫          70 次                        │
│ 查價名額            8 / 8 組，排隊中 5 個         │
│ 本月寄信            成功 30｜失敗 1｜待寄 0       │
└────────────────────────────────────────────────┘
┌─ 帳號 ─────────────────────────────────────────┐
│ Email          註冊日   佔名額  狀態             │
│ alice@...      11/01    2      正常    [停用]    │
│ spam1@...      11/09    0      已停用  [恢復]    │
│ demo@...       10/23    3      示範帳號          │
└────────────────────────────────────────────────┘
┌─ 追蹤（佔名額或排隊中）────────────────────────┐
│ 帳號        航線      出發日  狀態      建立時間 │
│ alice@...   TPE→NRT  12/20   查價中    [刪除]   │
│ spam1@...   TPE→LAX  10/01   排隊中    [刪除]   │
└────────────────────────────────────────────────┘
```
- `serpapi_remaining` 等為 `null` 時顯示「查詢失敗」或「—」，不擋住其他區塊
- 自己這一列、示範帳號、其他 admin 不顯示停用按鈕
- 停用、刪除前用現有的 `ConfirmDialog`。停用的文字要寫明「他的 N 個追蹤會被刪除，恢復帳號後也不會回來」
- 操作成功後重新抓三個區塊的資料（名額補位會影響用量和追蹤列表），並用現有的 Toast 顯示結果
- 用 TanStack Query 和 openapi-fetch，型別由後端的 `openapi.json` 重新產生（CI 會檢查）

### 文件
- `docs/deploy-runbook.md`：設定 admin 的 SQL
- `docs/01-requirements.md`：US-10 標為完成；新增一條管理帳號與追蹤的需求
- 相關階段文件與 `CLAUDE.md` 的狀態

## 留給實作者決定
- 後端模組內部的檔案切分、schema 命名、測試的切法
- 用量 API 呼叫 SerpApi 的逾時秒數（沿用 `ProviderDep` 的 15 秒即可）
- 前端元件拆分、表格樣式（沿用現有 `ui.ts` 的樣式）
- 日期顯示格式（沿用現有頁面）

## 測試重點
- 非 admin（一般帳號、示範帳號）呼叫每個 admin API 都回 403；未登入回 401
- 停用：追蹤全刪、refresh token 全刪、排隊者補位、之後該帳號 API 回 401、不能停用自己／示範帳號／其他 admin／已停用者
- 恢復：可以再登入、追蹤沒有回來
- 刪除追蹤：任何人的都能刪、補位正確、示範追蹤不能刪、不存在回 404
- 用量：各數字算法；SerpApi 失敗時 `serpapi_remaining`、`daily_budget`、`instant_remaining` 為 `null` 且 API 仍回 200
- 前端：非 admin 看不到入口、打 `/admin` 是找不到頁面；確認視窗文字；`null` 的顯示
