#!/usr/bin/env bash
# 建 arm64 的 backend image 並推上 ECR。
# 用法：infra/scripts/push-image.sh <tag>（tag 用 git SHA，例如 $(git rev-parse --short HEAD)）
# 事前：export AWS_PROFILE=farewatch；ECR 已由 Terraform 建立
set -euo pipefail

if [[ $# -ne 1 || -z "$1" ]]; then
  echo "用法：$0 <tag>" >&2
  exit 1
fi
tag="$1"

root="$(cd "$(dirname "$0")/../.." && pwd)"
# 可用環境變數 ECR_REPO 指定（例如 CI），沒有就從 Terraform output 讀
repo="${ECR_REPO:-$(terraform -chdir="$root/infra/terraform" output -raw ecr_repository_url)}"
registry="${repo%%/*}"
# registry 格式：<帳號>.dkr.ecr.<區域>.amazonaws.com，區域跟著 Terraform 走
region="$(cut -d. -f4 <<<"$registry")"

aws ecr get-login-password --region "$region" |
  docker login --username AWS --password-stdin "$registry"

# Lambda 不接受多架構 manifest，所以只建 arm64，並關掉 provenance
docker buildx build \
  --platform linux/arm64 \
  --provenance=false \
  -t "$repo:$tag" \
  --push \
  "$root/backend"

echo "已推送：$repo:$tag"
