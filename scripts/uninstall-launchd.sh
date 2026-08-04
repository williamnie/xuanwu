#!/usr/bin/env bash
set -euo pipefail

LABEL="${XUANWU_LAUNCHD_LABEL:-com.xiaobei.xuanwu}"
WEB_LABEL="${LABEL}.web"
CORE_LABEL="${LABEL}.core"
DOMAIN="gui/$(id -u)"

for label in "$WEB_LABEL" "$CORE_LABEL" "$LABEL"; do
  plist="$HOME/Library/LaunchAgents/$label.plist"
  launchctl bootout "$DOMAIN/$label" >/dev/null 2>&1 || launchctl bootout "$DOMAIN" "$plist" >/dev/null 2>&1 || true
  rm -f "$plist"
  echo "[launchd] stopped and removed: $plist"
done
