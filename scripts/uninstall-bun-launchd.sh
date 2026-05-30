#!/usr/bin/env bash
set -euo pipefail

LABEL="${CODEX_RUNNER_BUN_LAUNCHD_LABEL:-com.xiaobei.codex-issue-runner-bun}"
PLIST="${CODEX_RUNNER_BUN_PLIST:-$HOME/Library/LaunchAgents/$LABEL.plist}"
DOMAIN="gui/$(id -u)"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      echo "usage: scripts/uninstall-bun-launchd.sh [--dry-run]"
      exit 0
      ;;
    *)
      echo "[bun-launchd] unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

if [ "$LABEL" = "com.xiaobei.codex-issue-runner" ]; then
  echo "[bun-launchd] refusing to uninstall Go stable label" >&2
  exit 1
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[bun-launchd] dry-run would bootout: $DOMAIN/$LABEL"
  echo "[bun-launchd] dry-run would remove: $PLIST"
  exit 0
fi

launchctl bootout "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST"
echo "[bun-launchd] stopped and removed: $PLIST"
