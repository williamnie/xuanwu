#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/assert-external-deploy-context.sh"
LABEL="${CODEX_RUNNER_LAUNCHD_LABEL:-com.xiaobei.codex-issue-runner}"
ADDR="${CODEX_RUNNER_ADDR:-0.0.0.0:3008}"
CORE_ADDR="${CODEX_RUNNER_CORE_ADDR:-127.0.0.1:3009}"
WEB_LABEL="${LABEL}.web"
CORE_LABEL="${LABEL}.core"
APP_SUPPORT_DIR="${CODEX_RUNNER_APP_SUPPORT_DIR:-$HOME/Library/Application Support/codex-issue-runner-bun-live}"
STATE_DIR="${CODEX_RUNNER_STATE_DIR:-$APP_SUPPORT_DIR/state}"
DB_PATH="${CODEX_RUNNER_DB:-${CODEX_RUNNER_DEPLOY_DB:-$STATE_DIR/runner.db}}"
AUTH_TOKEN_FILE="${CODEX_RUNNER_AUTH_TOKEN_FILE:-$STATE_DIR/auth_token}"
AUTH_TOKEN="${CODEX_RUNNER_AUTH_TOKEN:-}"
SOURCE_WEB_DIR="${CODEX_RUNNER_SOURCE_WEB_DIR:-$ROOT_DIR/frontend/dist}"
WEB_DIR="${CODEX_RUNNER_WEB_DIR:-$STATE_DIR/web}"
BINARY_PATH="${CODEX_RUNNER_BINARY:-$ROOT_DIR/dist/codex-issue-runner}"
LAUNCHD_BINARY_PATH="${CODEX_RUNNER_LAUNCHD_BINARY:-$APP_SUPPORT_DIR/bin/codex-issue-runner}"
PI_PACKAGE_ASSET_SOURCE="${CODEX_RUNNER_PI_PACKAGE_ASSET_SOURCE:-$ROOT_DIR/backend-ts/node_modules/@earendil-works/pi-coding-agent}"
PI_PACKAGE_ASSET_DIR="${CODEX_RUNNER_PI_PACKAGE_ASSET_DIR:-$APP_SUPPORT_DIR/pi-coding-agent}"
RUNNER_SKILLS_SOURCE="${CODEX_RUNNER_SKILLS_SOURCE:-$ROOT_DIR/skills}"
RUNNER_PLUGINS_SOURCE="${CODEX_RUNNER_PLUGINS_SOURCE:-$ROOT_DIR/plugins}"
PHOTON_WASM_SOURCE="${CODEX_RUNNER_PHOTON_WASM_SOURCE:-$ROOT_DIR/backend-ts/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm}"
LOG_DIR="${CODEX_RUNNER_LOG_DIR:-$APP_SUPPORT_DIR/logs}"
CODEX_CMD="${CODEX_RUNNER_CODEX_CMD:-$(command -v codex || true)}"
CODEX_SERVER_MODE="${CODEX_RUNNER_CODEX_SERVER_MODE:-cli}"
CODEX_APP_CMD="${CODEX_RUNNER_CODEX_APP_CMD:-}"
AUTOMATION_SHADOW_W1="${CODEX_RUNNER_AUTOMATION_SHADOW_W1:-0}"
PATH_VALUE="${CODEX_RUNNER_PATH:-$PATH}"
LEGACY_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
WEB_PLIST="$HOME/Library/LaunchAgents/$WEB_LABEL.plist"
CORE_PLIST="$HOME/Library/LaunchAgents/$CORE_LABEL.plist"
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
  local addr="$1"
  if [[ "$addr" == 0.0.0.0:* ]]; then
    printf 'http://127.0.0.1:%s' "${addr##*:}"
  elif [[ "$addr" == :* ]]; then
    printf 'http://127.0.0.1%s' "$addr"
  else
    printf 'http://%s' "$addr"
  fi
}

write_custom_auth_token_file() {
  if [ -n "$AUTH_TOKEN" ]; then
    umask 077
    printf '%s\n' "$AUTH_TOKEN" > "$AUTH_TOKEN_FILE"
  fi
}

stage_file_atomically() {
  local source="$1" target="$2" mode="$3"
  local target_dir staged
  target_dir="$(dirname "$target")"
  mkdir -p "$target_dir"
  staged="$(mktemp "$target_dir/.codex-runner-stage.XXXXXX")"
  if ! { cp "$source" "$staged" && chmod "$mode" "$staged" && mv -f "$staged" "$target"; }; then
    rm -f "$staged"
    return 1
  fi
}

stage_launchd_binary() {
  # Never truncate a running Mach-O in place. macOS can mark that vnode's code
  # pages as tainted, after which launchd rejects even a valid new signature.
  stage_file_atomically "$BINARY_PATH" "$LAUNCHD_BINARY_PATH" 0755
  if [ -f "$BINARY_PATH.build.stamp" ]; then
    stage_file_atomically "$BINARY_PATH.build.stamp" "$LAUNCHD_BINARY_PATH.build.stamp" 0644
  fi
}

backup_current_runtime() {
  local rollback_dir="" source
  for source in "$LAUNCHD_BINARY_PATH" "$LAUNCHD_BINARY_PATH.build.stamp" "$LEGACY_PLIST" "$WEB_PLIST" "$CORE_PLIST"; do
    [ -e "$source" ] || continue
    if [ -z "$rollback_dir" ]; then
      rollback_dir="$APP_SUPPORT_DIR/rollback/$(date -u '+%Y%m%dT%H%M%SZ')"
      mkdir -p "$rollback_dir"
    fi
    cp -p "$source" "$rollback_dir/$(basename "$source")"
  done
  if [ -n "$rollback_dir" ]; then
    printf '%s\n' "$rollback_dir" > "$STATE_DIR/latest-runtime-rollback"
    echo "[launchd] rollback snapshot: $rollback_dir"
  fi
}

stage_web_dir() {
  rm -rf "$WEB_DIR"
  mkdir -p "$(dirname "$WEB_DIR")"
  cp -R "$SOURCE_WEB_DIR" "$WEB_DIR"
}

copy_if_exists() {
  local source="$1" target="$2"
  [ -e "$source" ] || return 0
  rm -rf "$target"
  cp -R "$source" "$target"
}

stage_pi_package_assets() {
  [ -f "$PI_PACKAGE_ASSET_SOURCE/package.json" ] || {
    echo "[launchd] missing PI package assets: $PI_PACKAGE_ASSET_SOURCE/package.json" >&2
    exit 1
  }
  rm -rf "$PI_PACKAGE_ASSET_DIR"
  mkdir -p "$PI_PACKAGE_ASSET_DIR"
  cp "$PI_PACKAGE_ASSET_SOURCE/package.json" "$PI_PACKAGE_ASSET_DIR/package.json"
  copy_if_exists "$PI_PACKAGE_ASSET_SOURCE/README.md" "$PI_PACKAGE_ASSET_DIR/README.md"
  copy_if_exists "$PI_PACKAGE_ASSET_SOURCE/CHANGELOG.md" "$PI_PACKAGE_ASSET_DIR/CHANGELOG.md"
  copy_if_exists "$PI_PACKAGE_ASSET_SOURCE/docs" "$PI_PACKAGE_ASSET_DIR/docs"
  copy_if_exists "$PI_PACKAGE_ASSET_SOURCE/examples" "$PI_PACKAGE_ASSET_DIR/examples"
  copy_if_exists "$PI_PACKAGE_ASSET_SOURCE/dist/modes/interactive/theme" "$PI_PACKAGE_ASSET_DIR/theme"
  copy_if_exists "$PI_PACKAGE_ASSET_SOURCE/dist/modes/interactive/assets" "$PI_PACKAGE_ASSET_DIR/assets"
  copy_if_exists "$PI_PACKAGE_ASSET_SOURCE/dist/core/export-html" "$PI_PACKAGE_ASSET_DIR/export-html"
  copy_if_exists "$RUNNER_SKILLS_SOURCE" "$PI_PACKAGE_ASSET_DIR/skills"
  copy_if_exists "$RUNNER_PLUGINS_SOURCE" "$PI_PACKAGE_ASSET_DIR/plugins"
  copy_if_exists "$PHOTON_WASM_SOURCE" "$(dirname "$LAUNCHD_BINARY_PATH")/photon_rs_bg.wasm"
}

wait_for_health() {
  local url="$1"
  for _ in {1..120}; do
    curl -fsS "$url/health" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

launchd_service_pid() {
  launchctl print "$DOMAIN/$1" 2>/dev/null |
    awk '/^[[:space:]]*pid =/ { print $3; exit }'
}

wait_for_service_unloaded() {
  local label="$1"
  for _ in {1..60}; do
    if ! launchctl print "$DOMAIN/$label" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  echo "[launchd] timed out waiting for $label to unload" >&2
  return 1
}

wait_for_process_exit() {
  local pid="${1:-}" label="$2"
  [ -n "$pid" ] || return 0
  for _ in {1..60}; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  echo "[launchd] timed out waiting for old $label process $pid to exit" >&2
  return 1
}

bootstrap_service() {
  local label="$1" plist="$2" attempt output status
  for attempt in {1..20}; do
    if output="$(launchctl bootstrap "$DOMAIN" "$plist" 2>&1)"; then
      return 0
    else
      status=$?
    fi
    # A transient launchd reply can race with successful registration.
    if launchctl print "$DOMAIN/$label" >/dev/null 2>&1; then
      echo "[launchd] $label registered despite bootstrap status $status"
      return 0
    fi
    if [ "$attempt" -lt 20 ]; then
      echo "[launchd] bootstrap $label retry $attempt/20 after status $status" >&2
      sleep 0.25
      continue
    fi
    printf '%s\n' "$output" >&2
    return "$status"
  done
}

if [ -z "$CODEX_CMD" ]; then
  echo "[launchd] codex command not found; set CODEX_RUNNER_CODEX_CMD=/absolute/path/to/codex" >&2
  exit 1
fi

if [[ "$AUTOMATION_SHADOW_W1" != "0" && "$AUTOMATION_SHADOW_W1" != "1" ]]; then
  echo "[launchd] CODEX_RUNNER_AUTOMATION_SHADOW_W1 must be 0 or 1" >&2
  exit 1
fi

APP_VERSION="$("$ROOT_DIR/scripts/resolve-version.sh")"
echo "[launchd] version: $APP_VERSION"
env VITE_APP_VERSION="$APP_VERSION" npm --prefix "$ROOT_DIR/frontend" run build
CODEX_RUNNER_CODESIGN_IDENTIFIER="${CODEX_RUNNER_CODESIGN_IDENTIFIER:-$LABEL}" \
CODEX_RUNNER_VERSION="$APP_VERSION" \
  "$ROOT_DIR/backend-ts/scripts/build-binary.sh"
mkdir -p "$STATE_DIR" "$(dirname "$DB_PATH")" "$(dirname "$AUTH_TOKEN_FILE")" "$LOG_DIR" "$HOME/Library/LaunchAgents"
backup_current_runtime
stage_launchd_binary
stage_pi_package_assets
stage_web_dir
write_custom_auth_token_file

cat > "$WEB_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$WEB_LABEL")</string>
  <key>Program</key>
  <string>$(xml_escape "$LAUNCHD_BINARY_PATH")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$LAUNCHD_BINARY_PATH")</string>
    <string>serve</string>
    <string>--role</string>
    <string>web</string>
    <string>--addr</string>
    <string>$(xml_escape "$ADDR")</string>
    <string>--core-addr</string>
    <string>$(xml_escape "$CORE_ADDR")</string>
    <string>--web-dir</string>
    <string>$(xml_escape "$WEB_DIR")</string>
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
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$LOG_DIR/launchd.web.out.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$LOG_DIR/launchd.web.err.log")</string>
</dict>
</plist>
PLIST

cat > "$CORE_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$CORE_LABEL")</string>
  <key>Program</key>
  <string>$(xml_escape "$LAUNCHD_BINARY_PATH")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$LAUNCHD_BINARY_PATH")</string>
    <string>serve</string>
    <string>--role</string>
    <string>core</string>
    <string>--addr</string>
    <string>$(xml_escape "$CORE_ADDR")</string>
    <string>--state-dir</string>
    <string>$(xml_escape "$STATE_DIR")</string>
    <string>--db</string>
    <string>$(xml_escape "$DB_PATH")</string>
    <string>--auth-token-file</string>
    <string>$(xml_escape "$AUTH_TOKEN_FILE")</string>
    <string>--codex-cmd</string>
    <string>$(xml_escape "$CODEX_CMD")</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$(xml_escape "$HOME")</string>
    <key>PATH</key>
    <string>$(xml_escape "$PATH_VALUE")</string>
    <key>PI_PACKAGE_DIR</key>
    <string>$(xml_escape "$PI_PACKAGE_ASSET_DIR")</string>
    <key>CODEX_RUNNER_CODEX_SERVER_MODE</key>
    <string>$(xml_escape "$CODEX_SERVER_MODE")</string>
    <key>CODEX_RUNNER_CODEX_APP_CMD</key>
    <string>$(xml_escape "$CODEX_APP_CMD")</string>
    <key>CODEX_RUNNER_MANAGED_EXECUTION</key>
    <string>1</string>
    <key>CODEX_RUNNER_AUTOMATION_SHADOW_W1</key>
    <string>$(xml_escape "$AUTOMATION_SHADOW_W1")</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$LOG_DIR/launchd.out.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$LOG_DIR/launchd.err.log")</string>
</dict>
</plist>
PLIST

plutil -lint "$WEB_PLIST" >/dev/null
plutil -lint "$CORE_PLIST" >/dev/null
old_legacy_pid="$(launchd_service_pid "$LABEL" || true)"
old_web_pid="$(launchd_service_pid "$WEB_LABEL" || true)"
old_core_pid="$(launchd_service_pid "$CORE_LABEL" || true)"
launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || launchctl bootout "$DOMAIN" "$LEGACY_PLIST" >/dev/null 2>&1 || true
rm -f "$LEGACY_PLIST"
launchctl bootout "$DOMAIN/$WEB_LABEL" >/dev/null 2>&1 || true
launchctl bootout "$DOMAIN/$CORE_LABEL" >/dev/null 2>&1 || true
wait_for_service_unloaded "$LABEL"
wait_for_service_unloaded "$WEB_LABEL"
wait_for_service_unloaded "$CORE_LABEL"
wait_for_process_exit "$old_legacy_pid" "$LABEL"
wait_for_process_exit "$old_web_pid" "$WEB_LABEL"
wait_for_process_exit "$old_core_pid" "$CORE_LABEL"
bootstrap_service "$CORE_LABEL" "$CORE_PLIST"
bootstrap_service "$WEB_LABEL" "$WEB_PLIST"
launchctl enable "$DOMAIN/$CORE_LABEL" >/dev/null 2>&1 || true
launchctl enable "$DOMAIN/$WEB_LABEL" >/dev/null 2>&1 || true
launchctl kickstart -k "$DOMAIN/$CORE_LABEL"
wait_for_health "$(service_url "$CORE_ADDR")"
launchctl kickstart -k "$DOMAIN/$WEB_LABEL"
wait_for_health "$(service_url "$ADDR")"

"$ROOT_DIR/scripts/status-launchd.sh"
echo "[launchd] installed plists: $WEB_PLIST $CORE_PLIST"
echo "[launchd] binary: $LAUNCHD_BINARY_PATH"
echo "[launchd] web: $WEB_DIR"
echo "[launchd] logs: $LOG_DIR/launchd.web.*.log $LOG_DIR/launchd.out.log $LOG_DIR/launchd.err.log"
