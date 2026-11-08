#!/usr/bin/env bash
# 把 farewatch-api、farewatch-jobs 兩個 Lambda 換成指定 tag 的 image。
# 自動部署和手動回滾都用這支。
# 用法：infra/scripts/deploy-lambdas.sh <tag>（tag 是 commit 的前 7 碼，image 要已經在 ECR）
# 事前：export AWS_PROFILE=farewatch（GitHub Actions 由部署金鑰提供）
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
# registry 格式：<帳號>.dkr.ecr.<區域>.amazonaws.com，Lambda 和 ECR 在同一區
region="$(cut -d. -f4 <<<"$registry")"
image="$repo:$tag"
functions=(farewatch-api farewatch-jobs)

for fn in "${functions[@]}"; do
  echo "更新 $fn → $image"
  aws lambda update-function-code --region "$region" --function-name "$fn" --image-uri "$image" >/dev/null
  # 等更新完成，才不會在舊版還在跑時就換下一個或開始冒煙測試
  aws lambda wait function-updated --region "$region" --function-name "$fn"
done

for fn in "${functions[@]}"; do
  actual="$(aws lambda get-function --region "$region" --function-name "$fn" --query Code.ImageUri --output text)"
  if [[ "$actual" != "$image" ]]; then
    echo "$fn 的 image 是 $actual，不是 $image" >&2
    exit 1
  fi
done

echo "兩個 Lambda 都已換成 $image"
