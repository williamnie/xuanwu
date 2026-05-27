#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="${CODEX_RUNNER_LAUNCHD_LABEL:-com.xiaobei.codex-issue-runner}"
ADDR="${CODEX_RUNNER_ADDR:-0.0.0.0:3008}"
DB_PATH="${CODEX_RUNNER_DEPLOY_DB:-$ROOT_DIR/data/app.db}"
AUTH_TOKEN_FILE="${CODEX_RUNNER_AUTH_TOKEN_FILE:-$(dirname "$DB_PATH")/auth_token}"
AUTH_TOKEN="${CODEX_RUNNER_AUTH_TOKEN:-}"
ALLOWED_ORIGINS="${CODEX_RUNNER_ALLOWED_ORIGINS:-}"
WEB_DIR="${CODEX_RUNNER_WEB_DIR:-}"
BINARY_PATH="${CODEX_RUNNER_BINARY:-$ROOT_DIR/dist/codex-issue-runner}"
LAUNCHD_BINARY_PATH="${CODEX_RUNNER_LAUNCHD_BINARY:-$ROOT_DIR/data/bin/codex-issue-runner}"
LOG_DIR="${CODEX_RUNNER_LOG_DIR:-$ROOT_DIR/data/logs}"
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
    return
  fi
  if [[ "$ADDR" == :* ]]; then
    printf 'http://127.0.0.1%s' "$ADDR"
  else
    printf 'http://%s' "$ADDR"
  fi
}

web_dir_args() {
  if [ -n "$WEB_DIR" ]; then
    cat <<ARGS
    <string>--web-dir</string>
    <string>$(xml_escape "$WEB_DIR")</string>
ARGS
  fi
}

auth_token_file_args() {
  if [ -n "$AUTH_TOKEN_FILE" ]; then
    cat <<ARGS
    <string>--auth-token-file</string>
    <string>$(xml_escape "$AUTH_TOKEN_FILE")</string>
ARGS
  fi
}

allowed_origins_args() {
  if [ -n "$ALLOWED_ORIGINS" ]; then
    cat <<ARGS
    <string>--allowed-origins</string>
    <string>$(xml_escape "$ALLOWED_ORIGINS")</string>
ARGS
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

if [ -z "$CODEX_CMD" ]; then
  echo "[launchd] codex command not found; set CODEX_RUNNER_CODEX_CMD=/absolute/path/to/codex" >&2
  exit 1
fi

"$ROOT_DIR/scripts/build-release.sh"
mkdir -p "$(dirname "$DB_PATH")" "$(dirname "$AUTH_TOKEN_FILE")" "$LOG_DIR" "$HOME/Library/LaunchAgents"
stage_launchd_binary
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
    <string>--db</string>
    <string>$(xml_escape "$DB_PATH")</string>
    <string>--codex-cmd</string>
    <string>$(xml_escape "$CODEX_CMD")</string>
$(web_dir_args)
$(auth_token_file_args)
$(allowed_origins_args)
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

URL="$(service_url)"
for _ in {1..120}; do
  if curl -fsS "$URL/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

"$ROOT_DIR/scripts/status-launchd.sh"
echo "[launchd] installed plist: $PLIST"
if [ -n "$WEB_DIR" ]; then
  echo "[launchd] web dir override: $WEB_DIR"
else
  echo "[launchd] web: embedded in binary"
fi
echo "[launchd] binary: $LAUNCHD_BINARY_PATH"
echo "[launchd] logs: $LOG_DIR/launchd.out.log $LOG_DIR/launchd.err.log"
