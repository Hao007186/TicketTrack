# 部署手冊（正式環境）

[← 回總覽](architecture.md)｜相關：[階段 5 部署](05-deployment.md)、[階段 6 維運](06-operations.md)、[#7b 設計](superpowers/specs/2026-10-26-m1-terraform-design.md)

這份手冊從零開始，把 FareWatch 部署到 `https://hao007186.com`。指令都在 **Git Bash** 執行，除非特別註明，都在 repo 根目錄。

> **機密不要貼進聊天、不要 commit。** 下面需要輸入機密的指令都用 `read -rs`（輸入時畫面不顯示，也不會留在指令紀錄裡）。

> **Git Bash 會把以 `/` 開頭的參數改寫成 Windows 路徑**（`/farewatch/prod/x` 會變成 `C:/Program Files/Git/farewatch/prod/x`）。所以 SSM、CloudWatch log 這類名稱以 `/` 開頭的 AWS 指令，前面都加了 `MSYS_NO_PATHCONV=1`，照抄即可。不要用 `export` 全域設定它，部署腳本需要這個轉換。

> 終端機請用 **VS Code 內建的終端機（選 Git Bash）**。每開一個新終端機，先執行 `export AWS_PROFILE=farewatch`，沒設的話 AWS 指令會出現 `NoCredentials`。

> **區域一律用 ap-southeast-2（雪梨）。** 這個 AWS 帳號（Free plan）有一條我們改不了的組織政策（SCP），只開放雪梨；其他區域連列出清單都會出現 `explicit deny in a service control policy`。唯一例外是 CloudFront 用的 ACM 憑證放在 us-east-1，這也是允許的。主控台右上角的區域記得切到雪梨。

## 1. 會用到的帳號與工具

| 項目 | 用途 |
|---|---|
| AWS 帳號（已驗證） | 所有雲端資源，區域 ap-southeast-2（雪梨） |
| Cloudflare（已管理 hao007186.com 的 DNS） | 網站與寄信的 DNS 記錄 |
| Neon | 正式環境的 PostgreSQL |
| SerpApi | 查價 API key |
| Docker Desktop | 建 backend image（arm64） |
| Node.js 24、uv | build 前端、跑 migration |
| Terraform、AWS CLI v2 | 下面第 2 節安裝 |

## 2. 一次性手動準備

### 2.1 安裝 Terraform 與 AWS CLI
在 PowerShell 執行：
```powershell
winget install Hashicorp.Terraform
winget install Amazon.AWSCLI
```
**關掉再重開** VS Code 與終端機，讓新的 PATH 生效，然後確認：
```bash
terraform version   # Terraform v1.10 以上
aws --version       # aws-cli/2.x
```

### 2.2 建 IAM 使用者與存取金鑰
平常不用 root 帳號（權限最大，連關閉帳號都可以），改建一個管理員 IAM 使用者給 CLI 用。
（Free plan 帳號不能開 IAM Identity Center，所以用存取金鑰。）

1. 用 root 帳號登入 AWS 主控台
2. 建議先替 root 帳號開啟 MFA：右上角帳號名稱 → Security credentials → Assign MFA device
3. 搜尋 **IAM** → 左側 **Users** → Create user
   - User name：`farewatch-admin`，不用勾「Provide user access to the AWS Management Console」
   - Permissions options：**Attach policies directly** → 只勾 **AdministratorAccess**
   - **不要**設定 Permissions boundary（設了會讓權限被限縮，Terraform 會失敗）
4. 點進 `farewatch-admin` → **Security credentials** → Access keys → **Create access key** → 用途選 **Command Line Interface (CLI)** → 複製 Access key ID 與 Secret access key（Secret 只顯示一次，不要貼進聊天）
5. 在 Git Bash 設定 CLI：
   ```bash
   aws configure --profile farewatch
   ```
   | 問題 | 輸入 |
   |---|---|
   | AWS Access Key ID | 第 4 步的 Access key ID |
   | AWS Secret Access Key | 第 4 步的 Secret access key |
   | Default region name | `ap-southeast-2` |
   | Default output format | `json` |
6. 之後每次操作前：
   ```bash
   export AWS_PROFILE=farewatch
   aws sts get-caller-identity   # 應該顯示你的帳號 ID 與 user/farewatch-admin
   ```
   金鑰外洩時：IAM → `farewatch-admin` → Security credentials → 把舊金鑰 Deactivate 再 Delete，建一把新的重跑第 5 步。

### 2.3 建立存放 Terraform state 的 S3 bucket
Terraform 用 state 檔記住「已經建了哪些東西」。它一開始就需要地方存，所以這個 bucket 手動建：
```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
STATE_BUCKET="farewatch-tfstate-$ACCOUNT_ID"
aws s3api create-bucket --bucket "$STATE_BUCKET" --region ap-southeast-2 \
  --create-bucket-configuration LocationConstraint=ap-southeast-2
aws s3api put-bucket-versioning --bucket "$STATE_BUCKET" \
  --versioning-configuration Status=Enabled
aws s3api put-public-access-block --bucket "$STATE_BUCKET" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
echo "$STATE_BUCKET"   # 記下來，init 時要用
```

### 2.4 Neon 資料庫
1. 到 <https://neon.tech> 註冊
2. Create project：名稱 `farewatch`、Postgres 16、Region 選 **AWS Asia Pacific (Sydney)**（和 Lambda 同區，查資料庫才不用跨區來回）
3. 專案首頁 → **Connect**，複製兩組連線字串（都以 `postgresql://` 開頭、結尾有 `sslmode=require`）：
   - **Connection pooling 開啟**（主機名稱含 `-pooler`）：給 Lambda 用
   - **Connection pooling 關閉**：給 migration 用
   先貼在記事本，不要存進 repo。

### 2.5 Cloudflare API token 與 Zone ID
1. Cloudflare 右上角頭像 → My Profile → **API Tokens** → Create Token → 範本 **Edit zone DNS**
2. Zone Resources：Include → Specific zone → `hao007186.com` → Continue → Create Token，複製 token（只顯示一次）
3. 回到 `hao007186.com` 的 Overview 頁，右下角 **API** 區塊複製 **Zone ID**

### 2.6 把機密放進 SSM Parameter Store
Lambda 啟動時會讀 `/farewatch/prod/` 底下的參數，名稱轉大寫後當設定（例如 `jwt_secret` → `JWT_SECRET`）。**名稱只能用底線。**
```bash
# 資料庫（貼上 2.4 的 pooler 連線字串後按 Enter，輸入時不會顯示）
read -rs DB_URL; MSYS_NO_PATHCONV=1 aws ssm put-parameter --name /farewatch/prod/database_url \
  --type SecureString --value="$DB_URL"; unset DB_URL

# JWT 密鑰：產生隨機值，不需要知道內容（--value= 的寫法避免值以 - 開頭時被當成參數）
MSYS_NO_PATHCONV=1 aws ssm put-parameter --name /farewatch/prod/jwt_secret --type SecureString \
  --value="$(python -c 'import secrets; print(secrets.token_urlsafe(48))')"

# SerpApi key
read -rs SERP; MSYS_NO_PATHCONV=1 aws ssm put-parameter --name /farewatch/prod/serpapi_key \
  --type SecureString --value="$SERP"; unset SERP

# 正式環境用真的 SerpApi 查價
MSYS_NO_PATHCONV=1 aws ssm put-parameter --name /farewatch/prod/price_provider --type String --value=serpapi
```
確認（只列名稱，不顯示值），應該看到 4 個名稱：
```bash
MSYS_NO_PATHCONV=1 aws ssm get-parameters-by-path --path /farewatch/prod/ --query "Parameters[].Name"
```
填錯要重填時，在 `put-parameter` 加上 `--overwrite`。
`origin_verify_secret` 會由 Terraform 自動建立，不用手動加。

### 2.7 填 terraform.tfvars
```bash
cp infra/terraform/terraform.tfvars.example infra/terraform/terraform.tfvars
```
用編輯器打開 `infra/terraform/terraform.tfvars`，填入告警信箱、Cloudflare token 與 Zone ID。`image_tag` 部署時用 `-var` 傳入，這裡隨便填即可。這個檔案已在 `.gitignore`，不會進 git。

### 2.8 SES：驗證自己的信箱、申請解除沙盒
新帳號的 SES 在「沙盒」裡，只能寄給驗證過的信箱。
1. 主控台搜尋 **Amazon SES**（區域 ap-southeast-2）→ Identities → Create identity → **Email address** → 輸入你要收測試信的信箱 → 到信箱點驗證連結
2. 等第 3 節部署完、網域驗證通過後：SES → **Account dashboard** → Request production access
   - Mail type：Transactional
   - Website URL：`https://hao007186.com`
   - Use case：說明是機票降價通知網站、只寄給自己註冊的使用者、每天少量、有退信處理
   審核約 1 天。通過前只能寄給第 1 步驗證過的信箱。

### 2.9 確認 Cloudflare 上沒有會衝突的舊記錄
網域改到 Cloudflare 時，Cloudflare 可能匯入了原註冊商的記錄（例如根網域的停車頁 A／AAAA）。Terraform 要建的記錄如果已經存在，apply 會在最後一步失敗。

到 Cloudflare → `hao007186.com` → **DNS → Records**，確認下面這些名稱**沒有**任何記錄，有的話先刪掉：
- `hao007186.com`（根網域，A／AAAA／CNAME）
- `mail`
- `_dmarc`
- 名稱含 `_domainkey` 的記錄

## 3. 第一次部署
```bash
export AWS_PROFILE=farewatch
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
TAG=$(git rev-parse --short HEAD)
```

1. **初始化 Terraform**
   ```bash
   cd infra/terraform
   terraform init -backend-config="bucket=farewatch-tfstate-$ACCOUNT_ID"
   ```
   應該看到 `Terraform has been successfully initialized!`
2. **先只建 ECR**（Lambda 建立時 image 必須已經存在）
   ```bash
   terraform apply -var image_tag="$TAG" \
     -target=aws_ecr_repository.backend -target=aws_ecr_lifecycle_policy.backend
   ```
   確認 plan 只有這 2 個資源再輸入 `yes`
3. **推 backend image**（arm64 在 x86 電腦上是模擬建置，第一次要幾分鐘）
   ```bash
   cd ../..
   infra/scripts/push-image.sh "$TAG"
   ```
4. **建立全部資源**
   ```bash
   cd infra/terraform
   terraform plan -var image_tag="$TAG" -out tfplan
   terraform apply tfplan
   rm tfplan   # plan 檔裡有 Cloudflare token 等明文，用完就刪（也已列入 .gitignore）
   ```
   - 先看 plan 的資源清單沒有奇怪的東西（應該全部是 create）
   - 憑證驗證與 CloudFront 建立要 5～30 分鐘，apply 會停在那裡等，正常
   - 告警信箱會收到 AWS Notification 的訂閱確認信，點 Confirm subscription
   - 確認訂閱後可能馬上收到一封 `farewatch-jobs-not-running` 告警：jobs 還沒執行過，所以「一整天沒執行」成立。這是預期的，第 4 節手動查價一次後會恢復 OK
   - 確認 SES 網域驗證完成（DNS 生效可能要一段時間）：
     ```bash
     aws sesv2 get-email-identity --email-identity hao007186.com \
       --query "{verified:VerifiedForSendingStatus,dkim:DkimAttributes.Status}"
     ```
     要看到 `verified: true`、`dkim: SUCCESS`
5. **資料庫 migration 與初始資料**（用 2.4 的**直連**網址）
   ```bash
   cd ../../backend
   read -rs DATABASE_URL && export DATABASE_URL
   uv run python -m alembic upgrade head   # 不用 uv run alembic：alembic.exe 可能被 Windows 應用程式控制擋下
   uv run python -m app.seeds.reference
   uv run python -m app.seeds.demo
   unset DATABASE_URL
   cd ..
   ```
6. **部署前端**
   ```bash
   infra/scripts/deploy-frontend.sh
   ```

## 4. 驗收清單
- [ ] 瀏覽器打開 `https://hao007186.com` 看得到網站
- [ ] `curl -s https://hao007186.com/api/v1/health` 回 `{"status":"ok"}`
- [ ] 直接打 Lambda 公開網址回 403（證明繞不過 CloudFront）：
  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" "$(terraform -chdir=infra/terraform output -raw api_function_url)api/v1/health"
  ```
- [ ] 「以示範帳號瀏覽」可以登入，看得到示範追蹤與價格圖
- [ ] 用 2.8 驗證過的信箱註冊帳號、登入；**重新整理頁面後仍維持登入**
- [ ] 新增一個追蹤，目標價設得很高（例如 100000），然後手動查價一次（花 1 次 SerpApi 額度）：
  ```bash
  # --cli-read-timeout：查價可能超過 CLI 預設的 60 秒，避免 CLI 逾時後自動重送
  aws lambda invoke --function-name farewatch-jobs --cli-binary-format raw-in-base64-out \
    --cli-read-timeout 900 --payload '{"job":"check_prices"}' /tmp/out.json && cat /tmp/out.json
  ```
  回 `{"job": "check_prices", "exit_code": 0}`；網站右上角鈴鐺有新通知，信箱收到 `noreply@hao007186.com` 寄的信，信中連結是 `https://hao007186.com/...`
- [ ] 排程用台灣時間：
  ```bash
  aws scheduler get-schedule --name farewatch-check-prices \
    --query "{cron:ScheduleExpression,tz:ScheduleExpressionTimezone}"
  ```
  應該是 `cron(0 8 * * ? *)`、`Asia/Taipei`
- [ ] SNS 訂閱已確認；Billing → Budgets 看得到 `farewatch-monthly`
- [ ] 有問題時看 log：`MSYS_NO_PATHCONV=1 aws logs tail /aws/lambda/farewatch-api --since 10m`（jobs 換成 `farewatch-jobs`）

## 5. 之後的更新
- **更新後端**：
  ```bash
  TAG=$(git rev-parse --short HEAD)
  infra/scripts/push-image.sh "$TAG"
  terraform -chdir=infra/terraform apply -var image_tag="$TAG"
  ```
  ECR 的 tag 不能重複；同一個 commit 不能推兩次。
- **更新前端**：`infra/scripts/deploy-frontend.sh`（舊的 JS／CSS 不刪，讓還開著舊頁面的人不會出錯；`index.html` 設成每次重新確認）
- **有新的 migration**：照第 3 節第 5 步，只跑 `alembic upgrade head`。migration 一律向後相容，先跑 migration 再更新後端
- **更換機密**：`MSYS_NO_PATHCONV=1 aws ssm put-parameter --name /farewatch/prod/<名稱> --type SecureString --overwrite --value=...`。Lambda 只在冷啟動時讀 SSM，改完要讓它重新啟動：
  ```bash
  aws lambda update-function-configuration --function-name farewatch-api --description "rotated $(date +%F)"
  ```
  （jobs 同理）
- **回滾後端**：`terraform -chdir=infra/terraform apply -var image_tag=<上一版的 tag>`（ECR 保留最新 3 個）

## 6. 拆除
1. 清空前端 bucket（含所有版本）：S3 主控台選 `farewatch-frontend-<帳號 ID>` → Empty
2. 刪除 ECR 裡的 image：ECR 主控台 → `farewatch-backend` → 全選 → Delete
3. `terraform -chdir=infra/terraform destroy -var image_tag=x`
4. 手動刪除：SSM 的四個參數（`MSYS_NO_PATHCONV=1 aws ssm delete-parameters --names ...`）、Neon 專案、state bucket、SES 驗證的個人信箱、IAM 使用者 `farewatch-admin`（先刪存取金鑰）
