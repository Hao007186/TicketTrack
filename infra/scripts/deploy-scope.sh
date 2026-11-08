#!/usr/bin/env bash
# 判斷這次要部署後端、前端哪些部分。
# 用法：infra/scripts/deploy-scope.sh <上次部署成功的 commit，沒有就給空字串> <這次的 commit>
# 輸出兩行（可直接接到 $GITHUB_OUTPUT）：backend=true|false、frontend=true|false
# 要在 git repo 內執行，且要有完整歷史（actions/checkout 要 fetch-depth: 0）
set -euo pipefail

if [[ $# -ne 2 || -z "$2" ]]; then
  echo "用法：$0 <base_sha 或空字串> <head_sha>" >&2
  exit 1
fi
base="$1"
head="$2"

result() {
  echo "backend=$1"
  echo "frontend=$2"
}

# head 一定要存在，否則是呼叫錯誤，不能當成「不用部署」
git cat-file -e "$head^{commit}"

# 沒有成功紀錄，或那個 commit 已經不在歷史裡：全部部署
if [[ -z "$base" ]] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  result true true
  exit 0
fi

# head 和 base 相同或比較舊（連續合併時較舊的 CI 較晚結束）：不部署，避免把線上蓋回舊版
if git merge-base --is-ancestor "$head" "$base"; then
  result false false
  exit 0
fi

# 分岔歷史（例如 main 被改寫）：無法比較，全部部署
if ! git merge-base --is-ancestor "$base" "$head"; then
  result true true
  exit 0
fi

changed="$(git diff --name-only "$base" "$head")"
backend=false
frontend=false
if grep -q '^backend/' <<<"$changed"; then backend=true; fi
if grep -q '^frontend/' <<<"$changed"; then frontend=true; fi
result "$backend" "$frontend"
