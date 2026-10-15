#!/bin/sh
set -eu

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
validator="$root_dir/scripts/validate-runtime-mode.sh"
failures=0

expect_pass() {
  description=$1
  shift
  if "$@" >/dev/null 2>&1; then
    printf 'PASS: %s\n' "$description"
  else
    printf 'FAIL: %s\n' "$description"
    failures=$((failures + 1))
  fi
}

expect_fail() {
  description=$1
  shift
  if "$@" >/dev/null 2>&1; then
    printf 'FAIL: %s\n' "$description"
    failures=$((failures + 1))
  else
    printf 'PASS: %s\n' "$description"
  fi
}

expect_pass 'defaults are real-mode development' env -u APP_ENV -u MOCK_MODE "$validator"
expect_pass 'mock is allowed in test' env APP_ENV=test MOCK_MODE=true "$validator"
expect_pass 'real mode is allowed in staging' env APP_ENV=staging MOCK_MODE=false "$validator"
expect_pass 'real mode is allowed in production' env APP_ENV=production MOCK_MODE=false "$validator"
expect_fail 'mock is forbidden in production' env APP_ENV=production MOCK_MODE=true "$validator"
expect_fail 'ambiguous mock value is rejected' env APP_ENV=test MOCK_MODE=1 "$validator"
expect_fail 'unknown environment is rejected' env APP_ENV=prod MOCK_MODE=false "$validator"

if [ "$failures" -ne 0 ]; then
  printf '%s\n' "$failures runtime-mode test(s) failed" >&2
  exit 1
fi

printf '%s\n' 'All runtime-mode tests passed (7/7).'
