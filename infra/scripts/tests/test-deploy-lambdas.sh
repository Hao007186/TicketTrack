#!/usr/bin/env bash
# deploy-lambdas.sh 與 push-image.sh 的測試。
# 用放在 PATH 最前面的假 aws、docker、terraform 記錄呼叫，不會碰到真的 AWS。
# 用法：bash infra/scripts/tests/test-deploy-lambdas.sh
set -euo pipefail

scripts="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
bin="$work/bin"
mkdir -p "$bin"

# 假 aws：每次呼叫記一行參數；行為由 FAKE_* 環境變數控制
cat >"$bin/aws" <<'EOF'
#!/usr/bin/env bash
echo "aws $*" >>"$CALLS"
case "$*" in
  *"lambda update-function-code"*)
    if [[ -n "${FAKE_UPDATE_FAIL_FN:-}" && "$*" == *"--function-name $FAKE_UPDATE_FAIL_FN "* ]]; then
      echo "An error occurred (ResourceConflictException)" >&2
      exit 254
    fi
    ;;
  *"lambda get-function"*) echo "$FAKE_IMAGE_URI" ;;
  *"ecr describe-images"*)
    case "${FAKE_DESCRIBE:-found}" in
      found) echo '{"imageDetails":[{"imageTags":["abc1234"]}]}' ;;
      notfound)
        echo "An error occurred (ImageNotFoundException) when calling the DescribeImages operation" >&2
        exit 254
        ;;
      denied)
        echo "An error occurred (AccessDeniedException) when calling the DescribeImages operation" >&2
        exit 254
        ;;
    esac
    ;;
  *"ecr get-login-password"*) echo "fake-password" ;;
esac
exit 0
EOF
cat >"$bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >>"$CALLS"
cat >/dev/null || true
EOF
cat >"$bin/terraform" <<'EOF'
#!/usr/bin/env bash
echo "terraform $*" >>"$CALLS"
echo "999999999999.dkr.ecr.ap-southeast-2.amazonaws.com/from-terraform"
EOF
chmod +x "$bin"/*

export PATH="$bin:$PATH"
export CALLS="$work/calls.log"
export ECR_REPO="123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/farewatch-backend"

failures=0
pass() { echo "PASS $1"; }
fail() {
  echo "FAIL $1：$2"
  echo "--- 呼叫紀錄 ---"
  cat "$CALLS" 2>/dev/null || true
  failures=$((failures + 1))
}
reset() {
  : >"$CALLS"
  unset FAKE_UPDATE_FAIL_FN FAKE_DESCRIBE
  export FAKE_IMAGE_URI="$ECR_REPO:abc1234"
}

test_updates_both_functions_and_waits() {
  reset
  if ! bash "$scripts/deploy-lambdas.sh" abc1234 >/dev/null 2>&1; then
    fail "${FUNCNAME[0]}" "腳本非 0 結束"
    return
  fi
  local got
  got="$(grep -E 'update-function-code|wait function-updated' "$CALLS" |
    sed -E 's/.*(update-function-code|wait function-updated).*--function-name ([a-z-]+).*/\1 \2/')"
  local want="update-function-code farewatch-api
wait function-updated farewatch-api
update-function-code farewatch-jobs
wait function-updated farewatch-jobs"
  if [[ "$got" != "$want" ]]; then
    fail "${FUNCNAME[0]}" "呼叫順序不符：[$got]"
  elif ! grep -q -- "--image-uri $ECR_REPO:abc1234" "$CALLS"; then
    fail "${FUNCNAME[0]}" "沒有用 $ECR_REPO:abc1234 更新"
  elif ! grep -q -- "--region ap-southeast-2" "$CALLS"; then
    fail "${FUNCNAME[0]}" "沒有指定 ECR 所在的區域"
  else
    pass "${FUNCNAME[0]}"
  fi
}

test_stops_when_first_update_fails() {
  reset
  export FAKE_UPDATE_FAIL_FN=farewatch-api
  if bash "$scripts/deploy-lambdas.sh" abc1234 >/dev/null 2>&1; then
    fail "${FUNCNAME[0]}" "第一個失敗時應該非 0 結束"
  elif grep -q "farewatch-jobs" "$CALLS"; then
    fail "${FUNCNAME[0]}" "第一個失敗後不應該更新第二個"
  else
    pass "${FUNCNAME[0]}"
  fi
}

test_fails_when_image_uri_mismatch() {
  reset
  export FAKE_IMAGE_URI="$ECR_REPO:old0000"
  if bash "$scripts/deploy-lambdas.sh" abc1234 >/dev/null 2>&1; then
    fail "${FUNCNAME[0]}" "ImageUri 不符時應該非 0 結束"
  else
    pass "${FUNCNAME[0]}"
  fi
}

test_requires_tag() {
  reset
  if bash "$scripts/deploy-lambdas.sh" >/dev/null 2>&1; then
    fail "${FUNCNAME[0]}" "沒有 tag 時應該非 0 結束"
  elif [[ -s "$CALLS" ]]; then
    fail "${FUNCNAME[0]}" "沒有 tag 時不應該呼叫任何指令"
  else
    pass "${FUNCNAME[0]}"
  fi
}

test_push_skips_existing_tag() {
  reset
  export FAKE_DESCRIBE=found
  if ! bash "$scripts/push-image.sh" abc1234 >/dev/null 2>&1; then
    fail "${FUNCNAME[0]}" "tag 已存在時應該以 0 結束"
  elif grep -q "docker buildx" "$CALLS"; then
    fail "${FUNCNAME[0]}" "tag 已存在時不應該建 image"
  elif ! grep -q -- "--repository-name farewatch-backend" "$CALLS"; then
    fail "${FUNCNAME[0]}" "describe-images 的 repository 名稱不對"
  else
    pass "${FUNCNAME[0]}"
  fi
}

test_push_builds_when_tag_missing() {
  reset
  export FAKE_DESCRIBE=notfound
  if ! bash "$scripts/push-image.sh" abc1234 >/dev/null 2>&1; then
    fail "${FUNCNAME[0]}" "腳本非 0 結束"
  elif ! grep -q "docker buildx build .*-t $ECR_REPO:abc1234" "$CALLS"; then
    fail "${FUNCNAME[0]}" "tag 不存在時應該建 image"
  else
    pass "${FUNCNAME[0]}"
  fi
}

test_push_fails_on_other_errors() {
  reset
  export FAKE_DESCRIBE=denied
  if bash "$scripts/push-image.sh" abc1234 >/dev/null 2>&1; then
    fail "${FUNCNAME[0]}" "其他錯誤應該非 0 結束"
  elif grep -q "docker buildx" "$CALLS"; then
    fail "${FUNCNAME[0]}" "其他錯誤不應該當成 tag 不存在而建 image"
  else
    pass "${FUNCNAME[0]}"
  fi
}

test_updates_both_functions_and_waits
test_stops_when_first_update_fails
test_fails_when_image_uri_mismatch
test_requires_tag
test_push_skips_existing_tag
test_push_builds_when_tag_missing
test_push_fails_on_other_errors

if ((failures > 0)); then
  echo "$failures 個測試失敗"
  exit 1
fi
echo "全部通過"
