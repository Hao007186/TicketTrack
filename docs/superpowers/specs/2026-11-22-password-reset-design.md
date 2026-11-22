# 忘記密碼、修改密碼與登入失敗提醒 設計

日期：2026-11-22　分支：`feat/password-reset`

## 為什麼要做
維護者忘記管理員密碼時，只能自己在本機產生 Argon2 雜湊，再到 Neon SQL Editor 手動改 `users.password_hash`（2026-11-22 實際發生過）。忘記密碼原本排在 M4（`docs/architecture.md` 第 20 項），因為這次的經驗提前做。順便補上兩件相關的事：
1. **修改密碼**：設定頁目前沒有任何改密碼的方式
2. **登入失敗提醒**：打錯 5 次會鎖 15 分鐘，但畫面上看不到剩幾次，也不知道要等多久

## 目標
- 忘記密碼的人可以自己從登入頁用 Email 重設，不用碰資料庫
- 已登入的人可以在設定頁改密碼
- 登入打錯時看得到「再錯幾次會鎖定」；鎖定時看得到「大約還要等幾分鐘」，並且有連到忘記密碼的入口

## 不做（non-goals）
- 註冊時驗證 Email、修改 Email
- 全站或依 IP 的頻率限制（第 19 項維持不做），只做「同一個帳號多久能寄一封重設信」
- 定期清理過期的重設 token（數量極少，之後跟 refresh token 清理一起評估）
- 重設成功後自動登入（導回登入頁，用新密碼登入）
- HTML 信件（跟現有通知信一樣用純文字）
- 密碼強度規則的改變（沿用註冊的 8～128 字）

## 不能發生的事（anti-goals）
- 重設連結可以用第二次，或過期後還能用
- 資料庫存著可以直接拿來用的重設 token（只能存雜湊）
- 「申請重設」的回應因為 Email 有沒有註冊而不同（訊息、狀態碼都一樣）
- 有人一直按「寄出」就能讓同一個信箱被灌爆
- 重設或修改密碼後，舊的登入狀態（其他裝置的 refresh token）還能繼續用
- 示範帳號被改密碼或被重設
- 寄信失敗讓「申請重設」回 500

## 做法（Approaches）
| | 1. 資料庫存一次性 token（**採用**） | 2. 簽章連結（JWT） | 3. 6 位數驗證碼 |
|---|---|---|---|
| 做法 | 新表 `password_reset_tokens`，存亂數 token 的 SHA-256、到期時間、使用時間 | 連結用 JWT 密鑰簽章，內含使用者、到期時間、密碼雜湊指紋 | 寄驗證碼，回網站輸入 |
| 只能用一次 | 直接看 `used_at` | 靠「密碼一改指紋就變」間接達成 | 要另外記錄 |
| 頻率限制 | 查這張表的最新一筆 | 還是要另外存上次寄信時間 | 要另外存 |
| 其他 | 多一張表與 migration；寫法和現有 `refresh_tokens` 一樣 | 不直覺 | 6 位數可被暴力猜，要做猜錯作廢 |

使用者選 1：最好懂，跟現有的 refresh token 同一套做法。

登入失敗提醒的兩個選項：A. 顯示剩餘次數，B. 只放固定提醒不顯示次數。使用者選 **A**。顯示次數會讓人看出 Email 有沒有註冊，但註冊 API 本來就會回「此 Email 已註冊」，所以不會多出新的風險。

## 已決定的設計

### 資料表 `password_reset_tokens`（新 migration）
| 欄位 | 說明 |
|---|---|
| `id` | PK |
| `user_id` | FK → `users.id`，`ON DELETE CASCADE`，加 index |
| `token_hash` | `String(64)`，unique，token 的 SHA-256（沿用 `security.hash_refresh_token` 的做法，可以改名成通用的 `hash_token`） |
| `expires_at` | 建立後 **30 分鐘** |
| `used_at` | 用過或被作廢時填入，NULL 代表還能用 |
| `created_at` | `server_default=now()`，用來判斷頻率限制 |

model 放在 `app/modules/auth/models.py`，並在 `app/db/models.py` 註冊。

### 申請重設：`POST /api/v1/auth/password-reset/request`
- body：`{ "email": EmailStr }`
- **一律回 202**，body `{ "detail": "如果這個 Email 有註冊，重設信已寄出，請在 30 分鐘內點信裡的連結" }`（前端直接顯示）
- 只有符合下面所有條件才會寄信，其他情況什麼都不做，直接回同樣的 202：
  - Email（先 `normalize_email`）存在
  - `is_active` 而且不是 `is_demo`
  - 這個使用者**最近 5 分鐘**內沒有建立過重設 token（頻率限制）
- 寄信時，在同一個 transaction 裡：把這個使用者所有 `used_at IS NULL` 的舊 token 作廢（填 `used_at`），新增一筆 token → commit → 用 `get_email_sender(settings)` 寄信。也就是**只有最新的那封信裡的連結有效**
- token：`secrets.token_urlsafe(32)`（沿用 `security.new_refresh_token`）
- 寄信失敗（`EmailError`）：寫 log（不記 token），仍然回 202；token 已經存了，使用者 5 分鐘後可以再申請
- 信件內容（純文字）：
  - 主旨：`FareWatch 重設密碼`
  - 內文：說明有人申請重設、連結 `{APP_BASE_URL}/reset-password?token=<token>`、30 分鐘內有效、只能用一次、不是本人申請可以忽略、重設後所有裝置都會被登出

### 完成重設：`POST /api/v1/auth/password-reset/confirm`
- body：`{ "token": str, "new_password": str(8～128) }`
- 用條件式 update 搶下 token（`token_hash` 相符、`used_at IS NULL`、`expires_at > now` → 設 `used_at = now`，`RETURNING user_id`），寫法比照 `refresh` 的「兩個請求同時用時只有一個成功」
- 搶不到，或使用者已停用／是示範帳號 → **400** `「重設連結已失效或已使用，請重新申請」`
- 成功時在同一個 transaction 裡：
  - `password_hash` 改成新密碼的 Argon2 雜湊
  - `failed_login_count = 0`、`locked_until = NULL`（**被鎖住的帳號立刻解鎖**）
  - 作廢這個使用者的其他重設 token
  - 作廢這個使用者所有的 refresh token（`revoked_at = now`）
- 回 **204**，不發新的登入 token

### 修改密碼：`POST /api/v1/me/password`
- 不放在 `/auth/` 底下：前端的 `authFetch` 對 `/api/v1/auth/` 開頭的請求遇到 401 時不會自動 refresh，放在 `/me` 底下，設定頁開很久後送出也能正常運作。回應設定的 refresh cookie 仍然用 `path=/api/v1/auth`
- 需要登入，使用 `WritableUser`（示範帳號回現有的 403「示範帳號為唯讀」）
- body：`{ "current_password": str, "new_password": str(8～128) }`
- 目前密碼錯誤：**跟登入共用同一個失敗計數**（`failed_login_count`、`locked_until`、5 次鎖 15 分鐘），回 **400**，訊息格式跟登入一樣帶剩餘次數；**觸發鎖定的第 5 次錯誤和已鎖定時都回 423**（跟登入一致，service 共用同一組例外）。理由：access token 被偷時，不能拿這個端點無限猜密碼
- 新密碼跟目前密碼一樣 → 400 `「新密碼不能和目前的密碼相同」`
- 成功：更新雜湊、重設失敗計數、作廢這個使用者**所有**的 refresh token（包括目前這台），然後用 `issue_tokens` 發一組新的，回 200 `TokenResponse` 並設定 refresh cookie。結果是：**目前這台保持登入，其他裝置被登出**
- 其他裝置手上還沒過期的 access token 最多再用 15 分鐘（`access_token_minutes`），接受

### 登入失敗提醒（改 `POST /auth/login`）
- 後端組好訊息放在 `detail`，前端照原樣顯示：
  - 密碼錯誤、還沒到 5 次 → 401 `「Email 或密碼錯誤，再錯 N 次會鎖定 15 分鐘」`（N = 5 − 目前失敗次數）
  - **第 5 次錯誤**（觸發鎖定的那次）→ 直接回 **423** `「登入失敗次數過多，帳號已鎖定，請約 15 分鐘後再試，或使用忘記密碼重設」`
  - 已鎖定時再登入 → 423，同樣的訊息，分鐘數 = `locked_until − now` 無條件進位（最少 1）
- Email 不存在、帳號停用、示範帳號 → 維持現在的 401 `「Email 或密碼錯誤」`，不帶次數（停用或示範帳號打錯時一樣會計數，只是不顯示）。**這兩種帳號就算已被鎖定也一律回 401**，不回 423，因為 423 的訊息會叫人用忘記密碼，而它們不能重設。實作上 `login` 的檢查順序要調整：先判斷是不是停用／示範帳號，再判斷鎖定
- 分鐘數、次數上限、鎖定時間都從 `MAX_FAILED_LOGINS`、`LOCKOUT_DURATION` 算，不要寫死在字串裡
- 現有的 `AccountLocked`、`InvalidCredentials` 例外要能帶上剩餘次數／分鐘，讓 router 組訊息

### 前端
- **登入頁**（`LoginPage.tsx`）：
  - 密碼欄位下方加「忘記密碼？」連結 → `/forgot-password`
  - 錯誤時照現在的方式顯示後端的 `detail`；status 是 423 時，錯誤框下方多一個「重設密碼」連結
  - 從重設成功導回時（`/login?reset=1`），表單上方顯示綠色提示「密碼已重設，請用新密碼登入」
- **`/forgot-password`**（新頁，不用登入，沿用 `AuthCard`）：輸入 Email → 送出後把表單換成後端回的訊息，加一個「回到登入」連結
- **`/reset-password?token=...`**（新頁，不用登入）：新密碼、確認新密碼兩個欄位。前端檢查「兩次一樣」、「至少 8 字」；成功 → **先清掉這個瀏覽器的登入狀態**（記憶體裡的 access token、使用者、query cache；不呼叫後端 logout，refresh token 已經被後端作廢了），再導到 `/login?reset=1`。這樣已登入的人重設後，不會被登入頁的「已登入就跳走」直接帶走，也不會停在一個 15 分鐘後才突然過期的狀態；被重設的帳號也不一定是目前登入的那個。`AuthProvider` 需要新增一個只清本機狀態的函式；400 → 顯示訊息和「重新申請」連結（→ `/forgot-password`）；網址沒有 token → 直接顯示「連結不完整」和重新申請的連結
- **設定頁**（`SettingsPage.tsx`）：新增「修改密碼」卡片，三個欄位（目前密碼、新密碼、確認新密碼），送出按鈕用 `WriteButton`（示範帳號自動停用）。成功後：用回傳的 access token 更新登入狀態、清空欄位、顯示「密碼已更新，其他裝置已登出」
- 兩個新頁加進 `routes.tsx`，放在 `RequireAuth` 外面；已登入的人打開也可以正常使用
- API 型別照現有流程用 `npm run gen:api` 從 OpenAPI 重新產生

### 測試（重點）
- 後端：申請重設對「存在／不存在／停用／示範／5 分鐘內重複」的帳號都回一樣的 202，只有該寄的才寄（用假的 EmailSender 檢查）；新 token 會作廢舊 token；confirm 成功後舊密碼不能登入、新密碼可以、refresh token 全部失效、鎖定解除；過期、用過、亂打的 token 回 400；同一個 token 同時送兩次只有一次成功；change-password 的錯誤計數與鎖定、示範帳號 403、成功後舊 refresh token 失效但新的可用；登入訊息的 N 與分鐘數
- 前端：三個頁面／卡片的成功與失敗畫面、登入頁 423 時出現重設連結、`?reset=1` 的提示

### 文件
- `docs/01-requirements.md`、`docs/02-design.md`、`docs/architecture.md`：忘記密碼從 v2／M4 改成已在 M1 後完成；架構文件第 20 項更新決策
- `docs/deploy-runbook.md`：不需要新增 AWS 資源或設定（SES 已解除沙盒、`APP_BASE_URL` 已存在）；手動驗收步驟加進第 4 節或另列：正式環境申請重設 → 收信 → 重設 → 舊密碼不能登入
- `CLAUDE.md` 的目前狀態在合併、部署後再更新

## 留給實作者決定
- service 函式怎麼拆、例外類別的命名
- 前端表單元件是否抽共用（密碼欄位＋確認欄位）
- 測試檔的分法
