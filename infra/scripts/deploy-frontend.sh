#!/usr/bin/env bash
# build 前端、上傳到 S3，並清掉 CloudFront 快取。
# 用法：infra/scripts/deploy-frontend.sh
# 事前：export AWS_PROFILE=farewatch 並 aws sso login；S3 與 CloudFront 已由 Terraform 建立
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
tf_output() {
  terraform -chdir="$root/infra/terraform" output -raw "$1"
}
# 可用環境變數指定（例如 CI），沒有就從 Terraform output 讀
bucket="${FRONTEND_BUCKET:-$(tf_output frontend_bucket)}"
distribution="${CLOUDFRONT_DISTRIBUTION_ID:-$(tf_output cloudfront_distribution_id)}"

(cd "$root/frontend" && npm ci && npm run build)

# --delete：刪掉 S3 上已經不存在的舊檔（舊版本仍保留在 bucket 的版本紀錄裡）
aws s3 sync "$root/frontend/dist" "s3://$bucket" --delete
aws cloudfront create-invalidation --distribution-id "$distribution" --paths "/*" >/dev/null

echo "前端已部署到 s3://$bucket，CloudFront 快取已清除"
