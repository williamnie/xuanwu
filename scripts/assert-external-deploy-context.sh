#!/usr/bin/env bash

if [ "${CODEX_RUNNER_MANAGED_EXECUTION:-}" = "1" ] ||
  { [ -n "${PI_PACKAGE_DIR:-}" ] && [ -n "${CODEX_RUNNER_CODEX_SERVER_MODE:-}" ]; }; then
  cat >&2 <<'MESSAGE'
[deploy-guard] denied: live deployment cannot run from a Runner-managed provider process.
[deploy-guard] Use focused tests/builds or ./dev.sh with isolated state and non-live ports.
[deploy-guard] After the Issue is committed and verified, run live deployment from an external operator or deployment worker.
MESSAGE
  exit 78
fi
