# M1 子專案 #6：前端 — 設計

日期：2026-10-25
狀態：已實作
相關文件：[architecture.md](../../architecture.md)、[02-design.md](../../02-design.md)、[#2 帳號系統設計](2026-10-23-m1-auth-design.md)、[#3 追蹤功能設計](2026-10-23-m1-watches-design.md)、[#4 查價設計](2026-10-23-m1-prices-design.md)、[#5 通知設計](2026-10-24-m1-alerts-design.md)

## 背景與目標
M1 的第 6 個子專案：做出使用者看得到的網站，接上 #2～#5 已完成的 API。對應 US-01～US-06、US-09（Email 開關）、US-11（示範帳號）。

**完成標準：**
- 下方〈測試〉列出的案例全部通過；前端測試不連後端
- PR 上的 CI 全綠，包含新增的 `frontend` job 和 openapi 一致性檢查
- 本機用瀏覽器手動走過：
  - 註冊 → 新增追蹤 → 用 mock 執行一次 `python -m app.jobs.check_prices` → 價格圖出現 → 通知中心有通知 → 標為已讀
  - 示範帳號瀏覽所有頁面，寫入按鈕都不能按
  - 開兩個分頁同時重新整理，不會被登出
  - 點 console 寄信器印出的信件連結，能連到追蹤詳情頁
- 手機寬度大致能用

## 不在範圍內
- LINE 綁定與通知開關（M2）
- 管理員用量頁 US-10（後端也還沒做，繼續延後）
- Playwright E2E（M3）
- 前端 Dockerfile（只有 M3 的 k8s 用得到）
- S3、CloudFront 部署（#7）
- 修改個人資料：後端沒有對應的 API
- 多語系：只做繁體中文

## 設計決定
| 項目 | 決定 | 理由 |
|---|---|---|
| 技術選型 | React + TypeScript + Vite、TanStack Query、Recharts、Tailwind（沿用 02-design）；路由用 React Router | React Router 最常見、資料最多 |
| 版面 | **電腦優先**：頂部導覽列加上置中的內容區；手機只求能用 | 面試官多半用電腦瀏覽示範帳號 |
| 示範帳號的寫入按鈕 | 照樣顯示但不能按，滑過去提示「示範帳號無法修改」；頂部固定顯示唯讀提示列；403 仍統一處理，當作保險 | 面試官看得到網站有哪些功能；比只靠 403 多出來的工作量很小 |
| access token 存放位置 | 只放在瀏覽器分頁的記憶體裡，不存 localStorage；網頁一打開先呼叫 `/auth/refresh` 恢復登入 | 網頁被插入惡意程式碼時，偷不走能長期使用的 token；refresh token 本來就在 HttpOnly cookie |
| refresh 排隊 | 同一個分頁的請求共用同一個 refresh 請求；跨分頁用 Web Locks API（`navigator.locks`）排隊 | 後端會把「舊 refresh token 被重用」當成被偷，作廢全部 token；多個分頁同時 refresh 會被誤判而登出 |
| API 型別 | 從後端的 OpenAPI 用 `openapi-typescript` 產生，搭配 `openapi-fetch`；產生出來的檔案 commit 進 repo，CI 檢查有沒有和最新的後端一致 | 後端改了欄位，前端在編譯時就會報錯 |
| 本機開發 | Vite 開發伺服器把 `/api` 轉給 `localhost:8000` | 對瀏覽器來說頁面和 API 在同一個網域，和正式環境的 CloudFront 一樣；後端不用開 CORS，cookie 也照常運作 |
| 表單 | React 內建的 state 搭配簡單驗證，不引入表單套件 | 只有 3 個表單；後端會再驗證一次 |
| 後端小改 | `BaselineOut` 加 `latest_booking_url`；`GET /notifications` 加可選的 `watch_id` 參數 | 詳情頁要訂票連結和這個追蹤的通知；在前端湊資料會漏 |

## 專案結構
```
frontend/
├─ index.html
├─ package.json / package-lock.json
├─ vite.config.ts        開發時把 /api 轉給 http://localhost:8000；Vitest 設定也放這裡
├─ tsconfig.json
├─ eslint.config.js / .prettierrc
├─ openapi.json          由 backend/scripts/export_openapi.py 產生，commit 進 repo
└─ src/
   ├─ main.tsx           進入點：QueryClient、AuthProvider、Router
   ├─ routes.tsx         路由表與「需要登入」的保護
   ├─ api/
   │  ├─ schema.d.ts     npm run gen:api 產生
   │  ├─ client.ts       openapi-fetch 的 client：帶 token、401 時 refresh 後重送
   │  ├─ errors.ts       ApiError（status、detail），把後端的錯誤訊息轉成中文字串
   │  └─ queries.ts      各 API 的 TanStack Query hook 與 query key
   ├─ auth/
   │  ├─ token.ts        記憶體裡的 access token、refresh 排隊（同分頁共用 promise + navigator.locks）
   │  └─ AuthProvider.tsx 啟動時恢復登入、目前使用者、login／register／demo／logout
   ├─ components/        Layout、NavBar、DemoBanner、NotificationBell、WriteButton、Toast、StatusBadge、ConfirmDialog
   ├─ pages/             HomePage、LoginPage、RegisterPage、WatchListPage、WatchFormPage、WatchDetailPage、NotificationsPage、SettingsPage、NotFoundPage
   ├─ lib/format.ts      金額（NT$ 10,372）、台灣時間、航線名稱
   └─ test/              MSW handlers、測試用資料、render 輔助函式
backend/scripts/export_openapi.py   不連資料庫，輸出 app.openapi() 到 frontend/openapi.json
```

**npm scripts：** `dev`、`build`（先 `tsc -b` 再 `vite build`）、`test`、`lint`（eslint + `prettier --check`）、`typecheck`、`gen:api`（openapi.json → `src/api/schema.d.ts`）。

## 頁面與網址
除了 `/`、`/login`、`/register`，其他頁面都要登入。沒登入就導到 `/login?next=<原網址>`，登入後回到原網址（`next` 只接受 `/` 開頭的站內路徑）。

| 網址 | 頁面 | 重點 |
|---|---|---|
| `/` | 首頁 | 沒登入時顯示產品介紹、「以示範帳號瀏覽」按鈕、登入／註冊；已登入就導到 `/watches` |
| `/login`、`/register` | 登入、註冊 | 直接顯示後端回的中文錯誤訊息；註冊的名稱是選填 |
| `/watches` | 我的追蹤 | 「進行中」分頁（active、queued、paused）和「歷史紀錄」分頁（expired）；每個追蹤一張卡片：航線、日期、目標價、狀態標籤，以及目前最低價和目標價的比較（來自 `/baseline`）；顯示「3 個追蹤已用 N 個」（N 只算 active 和 queued，和後端的名額計算相同；暫停的不佔名額），額滿時新增按鈕不能按；恢復暫停的追蹤遇到額滿時，後端回 409，顯示它的訊息 |
| `/watches/new`、`/watches/:id/edit` | 新增／編輯追蹤 | 同一個表單，見下方 |
| `/watches/:id` | 追蹤詳情 | 見〈追蹤詳情頁〉；通知的 link（`/watches/{id}`）直接對應到這裡 |
| `/notifications` | 通知中心 | 列表、未讀標示、標為已讀、全部標為已讀、「載入更多」（`before` 帶最後一則的 id）；價格通知附「去訂票」連結；通知連到的追蹤已刪除時，詳情頁會顯示「找不到這個追蹤」 |
| `/settings` | 設定 | 顯示 Email 和名稱（只能看）；Email 通知開關 |
| 其他 | 404 頁 | 「找不到這個頁面」，附回首頁的連結 |

**版面：**
- 頂部導覽列：左邊放 FareWatch 標誌和「我的追蹤」，右邊放鈴鐺（未讀數）和使用者選單（設定、登出）
- 內容區置中，最寬約 1100px
- 示範帳號時，導覽列上方多一條「你正在使用示範帳號，資料為唯讀」
- 手機寬度時，導覽列收合成選單按鈕，多欄區塊改成上下排列

## 新增／編輯追蹤表單
| 欄位 | 元件 | 規則 |
|---|---|---|
| 出發地 | 下拉選單 | 只列 `is_origin = true` 的機場 |
| 目的地 | 下拉選單，依國家分組 | 不能等於出發地 |
| 單程／來回 | 切換 | 選來回時才顯示回程日 |
| 出發日 | 日期 | 今天（台灣時間）起 3～330 天內，和後端的 `MIN_DAYS_AHEAD`、`MAX_DAYS_AHEAD` 相同 |
| 回程日 | 日期 | 不能早於出發日，也不能晚於今天起 330 天 |
| 艙等 | 下拉選單 | 後端的 `Cabin` 選項，顯示中文名稱 |
| 人數 | 數字 | 1～9 |
| 目標價（TWD） | 數字 | 1～1,000,000 |
| 航空公司 | 勾選清單 | 不勾就是全部 |

- 送出前先做上表的前端驗證；後端回 409、422 時，把 `detail` 顯示在表單上方
- 編輯時只送有改的欄位；改成單程時明確送 `return_date: null`
- 編輯時改了查價條件或目標價，送出前先提示「通知狀態會重置，之後的降價會重新判斷」
- 送出後的狀態是 `queued` 時，提示「目前全站名額已滿，有空位時會自動開始查價」
- 已過期的追蹤沒有編輯入口；直接開 `/watches/:id/edit` 時顯示「已過期的追蹤不能修改」

## 追蹤詳情頁
由上到下：
1. **標題列：** 航線（中文機場名稱與 IATA 代碼）、日期、單程或來回、艙等、人數、狀態標籤，以及編輯、暫停／恢復、刪除按鈕（刪除前跳出確認視窗）。已過期的追蹤不顯示編輯和暫停
2. **狀態提示：** 排隊中顯示「全站名額已滿，排隊中，暫不查價」；暫停顯示「已暫停，不會查價」；還沒有價格時顯示「每天查價一次，第一筆價格出來後就會顯示」
3. **數字卡片：** 目前最低價（附查價時間）、目標價、典型價格區間、歷史最低價；`history_ready = false` 時歷史最低價顯示「歷史資料累積中」；沒有典型區間時顯示「—」
4. **價格圖（Recharts）：**
   - 價格畫成折線，橫軸是日期
   - 目標價畫成水平虛線（`ReferenceLine`）
   - 典型價格區間畫成淡色的橫向色帶（`ReferenceArea`）
   - 滑鼠移到點上顯示價格、航空公司、查價時間
   - 可以切換 30 天、90 天、全部；預設 90 天，已過期的追蹤預設全部
5. **「去 Google Flights 訂票」按鈕：** 連到 `latest_booking_url`，新分頁開啟；沒有連結時不顯示
6. **這個追蹤的最近通知：** `GET /notifications?watch_id=<id>&limit=5`

找不到追蹤（404）時，整頁顯示「找不到這個追蹤，可能已被刪除」，附「回我的追蹤」連結。

## 後端小改
| 改動 | 內容 | 測試 |
|---|---|---|
| `BaselineOut.latest_booking_url: str \| None` | 取自 `/baseline` 已經查出來的最新一筆快照；沒有快照時為 NULL | 有快照時回最新一筆的連結；沒有快照時為 NULL |
| `GET /notifications?watch_id=<public_id>` | 可選參數；有帶時 join `alerts` → `watches`，只回這個追蹤的價格通知，並保留原本的 `user_id` 條件；`unread_count` 仍是全部未讀數 | 只回這個追蹤的通知；帶別人的追蹤 id 時回空清單；不存在的 id 回空清單 |
| `backend/scripts/export_openapi.py` | 呼叫 `create_app().openapi()`，排序 key 後寫成 JSON | CI 跑完後 `git diff --exit-code frontend/openapi.json` |

`watch_id` 對不到時一律回空清單，不回 404：前端只是拿來顯示「最近通知」，空清單就夠了，也不會洩漏追蹤是否存在。

## 資料流
**API client（`api/client.ts`）：**
1. 每個請求帶上 `Authorization: Bearer <access token>`
2. 回 401 而且不是 auth 端點時：refresh 一次，成功就重送原本的請求；每個請求最多重試一次
3. refresh 失敗：清掉登入狀態、清掉 TanStack Query 的快取、導到 `/login`，並提示「登入已過期，請重新登入」

**refresh 排隊（`auth/token.ts`）：**
- 同一個分頁：有 refresh 進行中時，其他請求等同一個 promise
- 跨分頁：`navigator.locks.request("farewatch-refresh", ...)` 取得鎖之後才送 `/auth/refresh`。前一個分頁換完後，瀏覽器的 cookie 已經是新的那張，下一個分頁送出的就是新 token
- 瀏覽器不支援 `navigator.locks` 時，退回只做同分頁共用

**啟動流程（`AuthProvider`）：**
1. 呼叫 refresh 恢復登入
2. 成功就呼叫 `/me`，取得使用者資料（包含 `is_demo`）
3. 期間顯示全頁載入畫面；確定登入狀態後才渲染路由，避免已登入的人先閃一下登入頁

**登出：** 呼叫 `/auth/logout`，不論成功與否都清掉記憶體裡的 token 和快取，再導到首頁。

**TanStack Query：**
- 機場、航空公司：`staleTime: Infinity`
- 其他資料：切回分頁時重新抓；未讀數每 60 秒抓一次
- 寫入成功後讓相關的 query key 失效：追蹤的增刪改 → 列表、詳情、baseline；標為已讀 → 通知列表、未讀數；通知設定 → 設定

## 錯誤處理
| 情況 | 畫面 |
|---|---|
| 403（示範帳號；按鈕本來就不能按，這是保險） | Toast「示範帳號無法修改」 |
| 404 | 頁面內顯示「找不到…」並附返回連結 |
| 409、422 | 在表單上方或按鈕旁顯示後端的 `detail`；422 的 `detail` 是陣列時，取每一項的 `msg` |
| 423 | 登入頁顯示後端訊息「登入失敗次數過多，請稍後再試」 |
| 503（示範帳號尚未建立） | 首頁顯示「示範帳號暫時無法使用」 |
| 網路錯誤、5xx | Toast「連線失敗，請稍後再試」；頁面層級的讀取失敗顯示「重試」按鈕 |

## 示範帳號
- `WriteButton`：`is_demo` 時 `disabled`，加上 `title` 和 `aria-describedby` 提示「示範帳號無法修改」；一般帳號時就是普通按鈕
- 套用位置：表單送出、編輯、暫停／恢復、刪除、標為已讀、全部標為已讀、Email 通知開關
- 列表的「新增追蹤」只是換頁，示範帳號也能按（不受名額限制），讓訪客打開表單看得到欄位；表單的送出按鈕才不能按

## 外觀
- 灰白底，搭配一個主色（藍色）；狀態標籤用不同顏色區分（active 綠、queued 黃、paused 灰、expired 淡灰）
- 字型 Noto Sans TC（Google Fonts），系統字型當備援
- 金額一律 `NT$ 10,372`；時間一律顯示台灣時間（`Asia/Taipei`）

## 測試
工具：Vitest + Testing Library + MSW（Mock Service Worker，在測試裡假造 API 回應，不需要啟動後端）。

| 對象 | 案例 |
|---|---|
| `api/client.ts` | 帶上 token；401 後 refresh 並重送；多個請求同時 401 只 refresh 一次；refresh 失敗時清掉登入狀態；重送後仍 401 時不再重試 |
| `api/errors.ts` | `detail` 是字串、是 422 陣列、沒有 `detail` 時的訊息 |
| `auth` | 啟動時 refresh 成功就恢復登入；失敗時視為沒登入；沒登入開需要登入的頁面會導到 `/login?next=`，登入後回到原網址；`next` 不是站內路徑時忽略 |
| `WriteButton` | 示範帳號時不能按、有提示；一般帳號時可以按 |
| 追蹤表單 | 來回才顯示回程日；同機場、回程早於出發、出發日不在 3～330 天內會擋下；後端 409／422 的訊息有顯示；回傳 `queued` 時有提示；改成單程時送出 `return_date: null` |
| 追蹤列表 | 兩個分頁放對追蹤；3 個額滿時新增按鈕不能按 |
| 詳情頁 | 404 顯示「找不到」；已過期預設 range=all 且沒有編輯、暫停；`history_ready = false` 時顯示「累積中」；沒有價格時顯示提示 |
| 通知中心 | 標為已讀後未讀數更新；「載入更多」帶上 `before` |
| `lib/format.ts` | 金額格式、台灣時間 |

後端改動的 pytest 見〈後端小改〉。價格圖只測「有資料時有畫出來、沒資料時顯示提示」，外觀靠瀏覽器手動確認。

## CI
新增 `frontend` job（`working-directory: frontend`）：
1. `actions/setup-node`（Node 24 LTS，npm 快取）
2. `npm ci`
3. `npm run gen:api` 後 `git diff --exit-code src/api/schema.d.ts`
4. `npm run lint`、`npm run typecheck`、`npm test`、`npm run build`

backend job 新增一步：`uv run python scripts/export_openapi.py` 後 `git diff --exit-code ../frontend/openapi.json`。

`frontend` job 要加進 main 的 branch protection 必須通過的檢查，由使用者在 GitHub 設定。

## 本機開發
1. 安裝 Node.js 24 LTS（`winget install OpenJS.NodeJS.LTS`）
2. `docker compose -f deploy/docker-compose.yml up` 啟動後端和資料庫
3. `cd frontend && npm install && npm run dev`，打開 `http://localhost:5173`
4. 後端 API 有改時：`uv run python scripts/export_openapi.py` → `npm run gen:api`

`APP_BASE_URL` 的預設值已經是 `http://localhost:5173`，通知信的連結在本機可以直接點。

## 文件更新
- `02-design.md`：API 草案加上 `GET /notifications` 的 `watch_id` 參數；前端頁面一節補上「示範帳號的寫入按鈕不能按」
- `03-development.md`：專案結構的 `frontend/` 一行更新成實際結構（不含 Dockerfile，M3 再加）；本機開發步驟補上前端
- `04-testing.md`：前端單元測試的工具補上 MSW
