# 立即查價 — 設計

日期：2026-11-03
狀態：待審閱
相關文件：[architecture.md](../../architecture.md)、[02-design.md](../../02-design.md)、[#4 查價設計](2026-10-23-m1-prices-design.md)、[#5 通知設計](2026-10-24-m1-alerts-design.md)、[#6 前端設計](2026-10-25-m1-frontend-design.md)、[#7b 設計](2026-10-26-m1-terraform-design.md)

## 背景與目標
目前建立追蹤後要等隔天 08:00 的排程才有第一筆價格，詳情頁在那之前是空的。改成建立追蹤或修改查價條件後立刻查價一次，並為此加上每人每天的次數上限，保護每月 250 次的 SerpApi 額度。

**完成標準：**
- 下方〈測試〉列出的案例全部通過，PR 上的 CI 全綠
- 正式環境實測一次（花 1 次額度）：新增追蹤後，詳情頁顯示「查價中…」，數秒內出現價格；目標價設 100000 時，鈴鐺和信箱都當下收到通知

## 不在範圍內
- 手動重試按鈕：失敗就等隔天 08:00 的排程
- 顯示「今天還剩幾次」
- 恢復暫停的追蹤時立即查價
- 使用者查價中關掉頁面後的保證：查價可能沒跑完，由排程補上
- 清除舊的次數紀錄：每人每天最多一筆，量很小

## 設計決定
| 項目 | 決定 | 理由 |
|---|---|---|
| 觸發方式 | 新增或改條件成功後，前端另外發 `POST /watches/{id}/check` | Lambda 回應後就會被凍結，不能在背景查價；分開請求讓建立追蹤永遠很快，查價失敗也不影響追蹤。比交給 jobs Lambda 少一套權限與輪詢 |
| 發送時機 | 表單送出成功時發一次，不是詳情頁載入時 | 重新整理頁面不會多花額度 |
| 每人上限 | 每天 3 次，台灣時間換日 | 使用者決定；等於每人的追蹤上限，正常使用不會碰到 |
| 全站上限 | 全站當天立即查價總數不超過 `daily_budget(remaining, today)` | 每人上限擋不住多帳號；公開註冊下要保護月額度 |
| 免費情況 | 相同條件今天已查過就不呼叫 SerpApi，也不扣次數 | 沿用「每個 query 每天最多查一次」的規則 |
| 失敗時 | 退回次數、還原 `last_checked_at` | 使用者不必為系統失敗付出次數；排程隔天優先重查 |
| 逾時 | 查額度與查價合計 15 秒；排程維持 60 秒 | API Lambda 上限 30 秒，要留時間給記錄結果與寄信 |
| 通知信 | 查完價當下寄，每次最多 5 封；API Lambda 加 `ses:SendEmail` | 否則信可能要等到隔天 08:00。上限避免積壓的信拖到逾時，剩下的由排程寄 |
| 修改警告 | 改到查價條件且追蹤不是暫停中時跳確認，和通知重置併成一個視窗 | 使用者要求修改前先警告；文字寫「最多」，因為相同條件今天查過就不會扣 |
| 新增時 | 不警告 | 這是使用者要的預設行為 |

## 後端

### 資料表（新 migration）
`instant_check_usage`：
- `user_id`：FK `users.id`，`ON DELETE CASCADE`
- `day`：date，台灣時間的日期
- `count`：int
- 主鍵 `(user_id, day)`

model 放在 `app/modules/prices/models.py`。

### API（`app/modules/prices/router.py`）
`POST /api/v1/watches/{public_id}/check`

- 需要 `WritableUser`：示範帳號回 403，不花額度
- 別人的或不存在的追蹤回 404
- 其他情況都回 200，用 `result` 表示結果（這些是預期內的情況，不是錯誤）：

```json
{ "result": "checked" }
```

| `result` | 意思 | 扣次數 | 花 SerpApi 額度 |
|---|---|---|---|
| `checked` | 查到價格 | 是 | 是 |
| `no_result` | 查無航班 | 是 | 是 |
| `already_checked` | 相同條件今天已查過 | 否 | 否 |
| `not_eligible` | 追蹤不是啟用中，或在出發前 2 天內 | 否 | 否 |
| `user_limit` | 這個人今天 3 次用完 | 否 | 否 |
| `site_limit` | 全站今天的立即查價達上限 | 否 | 否 |
| `quota_exhausted` | SerpApi 本月額度用完 | 否 | 否 |
| `failed` | 查額度或查價失敗、逾時 | 否（退回） | 不一定（逾時時可能已花） |

### 流程（`app/modules/prices/instant.py`）
1. 取得追蹤；不是 `active`，或出發日在今天 + `STOP_CHECK_DAYS` 以內 → `not_eligible`
2. query 的 `last_checked_at` 是台灣時間今天 → `already_checked`
3. `provider.remaining_quota()`（不花額度）：
   - 失敗或逾時 → `failed`
   - 回 0 → 呼叫 `notify_quota_exhausted`，回 `quota_exhausted`
   - 回 None（mock）→ 下一步不檢查全站上限
4. 短 transaction：拿 advisory lock（新的鍵，和 `WATCH_LOCK_KEY` 分開）→ 這個人今天已達 3 次回 `user_limit` → 全站今天總數達 `daily_budget` 回 `site_limit` → 這個人的 `count` 加 1 → commit。鎖讓同時發多個請求也不會超過上限；呼叫 SerpApi 前就放掉
5. 沿用 `claim_query` 搶下 query；沒搶到（別人剛好在查）→ 退回次數，回 `already_checked`
6. `provider.search()`：`ProviderError` 或逾時 → 用 `_restore` 還原 `last_checked_at`、退回次數，回 `failed`
7. 沿用 `record_result` 記錄（含觸發規則與 `api_usage`）→ 回 `checked` 或 `no_result`
8. 第 7 步之後呼叫 `send_pending`。寄信的任何例外都只記 log，不影響回傳結果；沒寄出的信由排程重試

第 3 步排在第 4 步前，是因為全站上限要用剩餘額度計算，所以 SerpApi 查額度失敗時，即使這個人次數已用完也會回 `failed`。

第 7 步發生未預期例外時回 500：SerpApi 額度已花，次數不退，`last_checked_at` 不還原。前端當成 `failed` 顯示。

`checker.py` 的 `_restore` 改成公開函式 `restore_query`，讓 `instant.py` 使用。

### 逾時與寄信上限
- 第 3 步與第 6 步共用同一個 `asyncio.timeout(15)`；`TimeoutError` 視為失敗。API 的 httpx client 也用 15 秒
- `send_pending` 新增選填參數 `limit: int | None = None`，達到上限就結束。排程不傳，行為不變；這裡傳 5

### Terraform（`infra/terraform/ses.tf`）
新增 `aws_iam_role_policy.api_send_email`，把 `send_email` policy 也掛到 API 的 role，並更新「只有 jobs Lambda 會寄信」的註解。`EMAIL_SENDER`、`EMAIL_FROM`、`APP_BASE_URL` 兩個 Lambda 已經共用，不用改。

## 前端

### 資料取得（`src/api/queries.ts`）
- 新增 `useCheckWatch`：用 `mutationKey: ["check", id]` 的 mutation。完成後讓這筆追蹤的價格、基準、通知和未讀數重新載入
- 重新產生 openapi 型別

### 表單（`WatchFormPage`）
- 新增成功且 `saved.status === "active"` → 發查價請求（不等它完成）並跳到詳情頁
- 修改時，`src/lib/watchForm.ts` 新增 `changesConditions(body)`，只看查價條件欄位。條件有變且 `saved.status === "active"` 才查價；只改目標價不查價
- 條件有變且 `original.status !== "paused"` 時，確認視窗改用：

> 修改查價條件後會立即查價一次，最多消耗今天 3 次中的 1 次；次數用完時會等明天 08:00 查價。通知狀態也會重置，之後的降價會重新判斷。確定要儲存嗎？

- 其他會重置通知狀態的修改（只改目標價、暫停中的追蹤改條件）維持現有的 `RESET_CONFIRM`

### 詳情頁（`WatchDetailPage`）
用 `useIsMutating` 與 `useMutationState` 讀同一個 `mutationKey` 的狀態，顯示一行提示：

| 狀態 | 顯示 |
|---|---|
| 進行中 | 查價中… |
| `checked`、`already_checked` | 不顯示（價格已更新） |
| `no_result` | 這組條件目前查不到航班，明天 08:00 會再查 |
| `not_eligible` 且追蹤是 `active` | 出發前 2 天內不再查價 |
| `not_eligible` 且是其他狀態 | 不顯示（已有 `STATUS_HINTS`） |
| `user_limit` | 今天的立即查價次數已用完，明天 08:00 會自動查價 |
| `site_limit`、`quota_exhausted` | 目前無法立即查價，之後的排程會自動查價 |
| `failed` 或請求失敗 | 查價暫時失敗，明天 08:00 會再試 |

`quota_exhausted` 的情況下，排程要到下個月才會恢復查價，所以文字不寫明天。重新整理頁面後提示會消失，價格仍以後端資料為準。

## 測試
**後端（pytest，全部用 mock，不花額度）**
- `result` 的每一種情況，以及是否扣次數、是否呼叫 `search`
- 第 4 次請求回 `user_limit`；別人仍可查
- 全站達 `daily_budget` 回 `site_limit`；mock 回 None 時不檢查全站上限
- 同時發多個請求，次數不超過 3
- 跨到台灣時間隔天次數重新計算；用 UTC 算會算錯日的時段也要測
- 失敗與逾時都退回次數、還原 `last_checked_at`
- 搶不到 query 時退回次數
- 立即查價後，同一天的排程不再查這個 query
- 查完價寄信；寄信失敗仍回 `checked`；寄信上限 5 封，`send_pending` 不傳 `limit` 時行為不變
- 示範帳號 403、別人的追蹤 404、沒登入 401

**前端（vitest + MSW）**
- 新增後發一次查價請求；排隊中不發
- 改條件後發一次；只改目標價不發
- 警告只在條件有變且不是暫停中時出現，而且只跳一個視窗；取消後不送出
- 詳情頁各種結果的提示文字；查價請求失敗時顯示失敗提示，追蹤本身正常顯示
- 重新整理詳情頁不發查價請求

## 上線順序
資料庫先、前端最後，過程中舊版畫面仍可使用：
1. 跑 migration
2. 推新的後端 image，`terraform apply`（含新的 SES 權限）
3. 部署前端
4. 照〈完成標準〉實測一次

## 文件更新
- `docs/01-requirements.md`：查價頻率與額度策略加上立即查價
- `docs/02-design.md`：〈額度策略〉、〈API 草案〉、資料表
- `docs/04-testing.md`：對應測試項目
- `CLAUDE.md`：目前狀態
