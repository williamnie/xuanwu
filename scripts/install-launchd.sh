#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="${CODEX_RUNNER_LAUNCHD_LABEL:-com.xiaobei.codex-issue-runner}"
ADDR="${CODEX_RUNNER_ADDR:-0.0.0.0:3008}"
APP_SUPPORT_DIR="${CODEX_RUNNER_APP_SUPPORT_DIR:-$HOME/Library/Application Support/codex-issue-runner-bun-live}"
STATE_DIR="${CODEX_RUNNER_STATE_DIR:-$APP_SUPPORT_DIR/state}"
DB_PATH="${CODEX_RUNNER_DB:-${CODEX_RUNNER_DEPLOY_DB:-$STATE_DIR/runner.db}}"
AUTH_TOKEN_FILE="${CODEX_RUNNER_AUTH_TOKEN_FILE:-$STATE_DIR/auth_token}"
AUTH_TOKEN="${CODEX_RUNNER_AUTH_TOKEN:-}"
SOURCE_WEB_DIR="${CODEX_RUNNER_SOURCE_WEB_DIR:-$ROOT_DIR/frontend/dist}"
WEB_DIR="${CODEX_RUNNER_WEB_DIR:-$STATE_DIR/web}"
BINARY_PATH="${CODEX_RUNNER_BINARY:-$ROOT_DIR/dist/codex-issue-runner}"
LAUNCHD_BINARY_PATH="${CODEX_RUNNER_LAUNCHD_BINARY:-$APP_SUPPORT_DIR/bin/codex-issue-runner}"
LOG_DIR="${CODEX_RUNNER_LOG_DIR:-$APP_SUPPORT_DIR/logs}"
CODEX_CMD="${CODEX_RUNNER_CODEX_CMD:-$(command -v codex || true)}"
PATH_VALUE="${CODEX_RUNNER_PATH:-$PATH}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  printf '%s' "$value"
}

service_url() {
  if [[ "$ADDR" == 0.0.0.0:* ]]; then
    printf 'http://127.0.0.1:%s' "${ADDR##*:}"
  elif [[ "$ADDR" == :* ]]; then
    printf 'http://127.0.0.1%s' "$ADDR"
  else
    printf 'http://%s' "$ADDR"
  fi
}

write_custom_auth_token_file() {
  if [ -n "$AUTH_TOKEN" ]; then
    umask 077
    printf '%s\n' "$AUTH_TOKEN" > "$AUTH_TOKEN_FILE"
  fi
}

stage_launchd_binary() {
  mkdir -p "$(dirname "$LAUNCHD_BINARY_PATH")"
  cp "$BINARY_PATH" "$LAUNCHD_BINARY_PATH"
  chmod +x "$LAUNCHD_BINARY_PATH"
  if [ -f "$BINARY_PATH.build.stamp" ]; then
    cp "$BINARY_PATH.build.stamp" "$LAUNCHD_BINARY_PATH.build.stamp"
  fi
}

stage_web_dir() {
  rm -rf "$WEB_DIR"
  mkdir -p "$(dirname "$WEB_DIR")"
  cp -R "$SOURCE_WEB_DIR" "$WEB_DIR"
}

wait_for_health() {
  local url="$1"
  for _ in {1..120}; do
    curl -fsS "$url/health" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

if [ -z "$CODEX_CMD" ]; then
  echo "[launchd] codex command not found; set CODEX_RUNNER_CODEX_CMD=/absolute/path/to/codex" >&2
  exit 1
fi

npm --prefix "$ROOT_DIR/frontend" run build
"$ROOT_DIR/backend-ts/scripts/build-binary.sh"
mkdir -p "$STATE_DIR" "$(dirname "$DB_PATH")" "$(dirname "$AUTH_TOKEN_FILE")" "$LOG_DIR" "$HOME/Library/LaunchAgents"
stage_launchd_binary
stage_web_dir
write_custom_auth_token_file

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$LABEL")</string>
  <key>Program</key>
  <string>$(xml_escape "$LAUNCHD_BINARY_PATH")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$LAUNCHD_BINARY_PATH")</string>
    <string>serve</string>
    <string>--addr</string>
    <string>$(xml_escape "$ADDR")</string>
    <string>--state-dir</string>
    <string>$(xml_escape "$STATE_DIR")</string>
    <string>--db</string>
    <string>$(xml_escape "$DB_PATH")</string>
    <string>--auth-token-file</string>
    <string>$(xml_escape "$AUTH_TOKEN_FILE")</string>
    <string>--web-dir</string>
    <string>$(xml_escape "$WEB_DIR")</string>
    <string>--codex-cmd</string>
    <string>$(xml_escape "$CODEX_CMD")</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$(xml_escape "$HOME")</string>
    <key>PATH</key>
    <string>$(xml_escape "$PATH_VALUE")</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$LOG_DIR/launchd.out.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$LOG_DIR/launchd.err.log")</string>
</dict>
</plist>
PLIST

plutil -lint "$PLIST" >/dev/null
launchctl bootout "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
launchctl kickstart -k "$DOMAIN/$LABEL"
wait_for_health "$(service_url)"

"$ROOT_DIR/scripts/status-launchd.sh"
echo "[launchd] installed plist: $PLIST"
echo "[launchd] binary: $LAUNCHD_BINARY_PATH"
echo "[launchd] web: $WEB_DIR"
echo "[launchd] logs: $LOG_DIR/launchd.out.log $LOG_DIR/launchd.err.log"
