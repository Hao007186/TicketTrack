#!/usr/bin/env bash
# 判斷這次要部署後端、前端哪些部分。
# 用法：infra/scripts/deploy-scope.sh "<最近幾次部署成功的 commit，空白分隔，沒有就給空字串>" <這次的 commit>
# 輸出兩行（可直接接到 $GITHUB_OUTPUT）：backend=true|false、frontend=true|false
# 要在 git repo 內執行，且要有完整歷史（actions/checkout 要 fetch-depth: 0）
#
# 為什麼要多筆：連續合併時 CI 完成的順序不固定。較舊的 commit 判斷為不部署時，
# 那次執行仍算成功；只看最新一筆的話，之後更舊的 commit 會被當成比它新而部署上去
set -euo pipefail

if [[ $# -ne 2 || -z "$2" ]]; then
  echo "用法：$0 \"<deployed_sha ...>\" <head_sha>" >&2
  exit 1
fi
head="$2"

result() {
  echo "backend=$1"
  echo "frontend=$2"
}

# head 一定要存在，否則是呼叫錯誤，不能當成「不用部署」
git cat-file -e "$head^{commit}"

# 只留本機找得到的紀錄（例如 main 被改寫後舊 commit 會消失）
deployed=()
read -ra candidates <<<"$1"
for sha in "${candidates[@]}"; do
  if git cat-file -e "$sha^{commit}" 2>/dev/null; then deployed+=("$sha"); fi
done

# 沒有可用的紀錄：全部部署
if ((${#deployed[@]} == 0)); then
  result true true
  exit 0
fi

# head 和任何一筆已部署的相同或比較舊：不部署，避免把線上蓋回舊版
for sha in "${deployed[@]}"; do
  if git merge-base --is-ancestor "$head" "$sha"; then
    result false false
    exit 0
  fi
done

# 基準：歷史上最新的一筆（不是任何其他紀錄的祖先）；有分岔時取列表中較前（較新的執行）
base=""
for sha in "${deployed[@]}"; do
  newest=true
  for other in "${deployed[@]}"; do
    if [[ "$other" != "$sha" ]] && git merge-base --is-ancestor "$sha" "$other"; then
      newest=false
    fi
  done
  if $newest; then
    base="$sha"
    break
  fi
done

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
