#!/usr/bin/env bash
# build 前端、上傳到 S3，並清掉 CloudFront 快取。
# 用法：infra/scripts/deploy-frontend.sh
# 事前：export AWS_PROFILE=farewatch；S3 與 CloudFront 已由 Terraform 建立
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
tf_output() {
  terraform -chdir="$root/infra/terraform" output -raw "$1"
}
# 可用環境變數指定（例如 CI），沒有就從 Terraform output 讀
bucket="${FRONTEND_BUCKET:-$(tf_output frontend_bucket)}"
distribution="${CLOUDFRONT_DISTRIBUTION_ID:-$(tf_output cloudfront_distribution_id)}"

(cd "$root/frontend" && npm ci && npm run build)

# 不用 --delete：還開著舊頁面的使用者仍要載入得到舊的 JS／CSS（檔名帶 hash，佔空間很小）
aws s3 sync "$root/frontend/dist" "s3://$bucket" --exclude index.html
# index.html 最後上傳並要求瀏覽器每次重新確認，才不會拿舊的 index.html 去找已經換掉的檔案
aws s3 cp "$root/frontend/dist/index.html" "s3://$bucket/index.html" --cache-control no-cache
aws cloudfront create-invalidation --distribution-id "$distribution" --paths "/*" >/dev/null

echo "前端已部署到 s3://$bucket，CloudFront 快取已清除"
