#!/bin/sh
set -eu

app_env="${APP_ENV:-development}"
mock_mode="${MOCK_MODE:-false}"

case "$app_env" in
  development|test|staging|production) ;;
  *)
    printf '%s\n' "ERROR: APP_ENV must be development, test, staging, or production." >&2
    exit 64
    ;;
esac

case "$mock_mode" in
  true|false) ;;
  *)
    printf '%s\n' "ERROR: MOCK_MODE must be exactly true or false." >&2
    exit 64
    ;;
esac

if [ "$app_env" = "production" ] && [ "$mock_mode" = "true" ]; then
  printf '%s\n' "ERROR: MOCK_MODE=true is forbidden in production." >&2
  exit 78
fi

printf '%s\n' "runtime mode valid: APP_ENV=$app_env MOCK_MODE=$mock_mode"
