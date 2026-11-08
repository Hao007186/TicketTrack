#!/usr/bin/env bash
# deploy-scope.sh 的測試：在暫存 git repo 建 commit，逐一檢查輸出。
# 用法：bash infra/scripts/tests/test-deploy-scope.sh
set -euo pipefail

script="$(cd "$(dirname "$0")/.." && pwd)/deploy-scope.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

git init -q -b main
git config user.email test@example.com
git config user.name test
git config commit.gpgsign false
git config core.autocrlf false

commit() { # commit <檔案路徑>：建立或修改檔案並 commit，印出 SHA
  mkdir -p "$(dirname "$1")"
  echo "$RANDOM" >>"$1"
  git add "$1"
  git commit -q -m "change $1"
  git rev-parse HEAD
}

failures=0
check() { # check <名稱> <預期 backend> <預期 frontend> <base> <head>
  local name="$1" want="backend=$2"$'\n'"frontend=$3" got
  if ! got="$(bash "$script" "$4" "$5" 2>&1)"; then
    echo "FAIL $name：腳本非 0 結束：$got"
    failures=$((failures + 1))
  elif [[ "$got" != "$want" ]]; then
    echo "FAIL $name：預期 [$want]，實際 [$got]"
    failures=$((failures + 1))
  else
    echo "PASS $name"
  fi
}

root="$(commit README.md)"
be="$(commit backend/x)"
fe="$(commit frontend/x)"
doc="$(commit docs/x)"
doc2="$(commit docs/y)"
commit backend/y >/dev/null
doc3="$(commit docs/z)"

check "base 是空字串" true true "" "$doc"
check "base 在本機找不到" true true "0123456789abcdef0123456789abcdef01234567" "$doc"
check "base 與 head 相同" false false "$doc" "$doc"
check "只改 backend" true false "$root" "$be"
check "只改 frontend" false true "$be" "$fe"
check "只改 docs" false false "$doc" "$doc2"
check "中間有後端變更，最新只改文件" true false "$doc2" "$doc3"
check "head 比 base 舊" false false "$doc" "$be"

git checkout -q -b side "$root"
side="$(commit docs/side)"
check "分岔歷史" true true "$side" "$doc"

if ((failures > 0)); then
  echo "$failures 個測試失敗"
  exit 1
fi
echo "全部通過"
