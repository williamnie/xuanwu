#!/usr/bin/env bash
set -euo pipefail

LABEL="${CODEX_RUNNER_LAUNCHD_LABEL:-com.xiaobei.codex-issue-runner}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST"
echo "[launchd] stopped and removed: $PLIST"
