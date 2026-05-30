#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="${CODEX_RUNNER_BUN_LAUNCHD_LABEL:-com.xiaobei.codex-issue-runner-bun}"
ADDR="${CODEX_RUNNER_BUN_ADDR:-127.0.0.1:3018}"
STATE_DIR="${CODEX_RUNNER_BUN_STATE_DIR:-$ROOT_DIR/data-bun}"
DB_PATH="${CODEX_RUNNER_BUN_DB:-$STATE_DIR/runner.db}"
AUTH_TOKEN_FILE="${CODEX_RUNNER_BUN_AUTH_TOKEN_FILE:-$STATE_DIR/auth_token}"
AUTH_TOKEN="${CODEX_RUNNER_BUN_AUTH_TOKEN:-}"
BINARY_PATH="${CODEX_RUNNER_BUN_BINARY:-$ROOT_DIR/dist/codex-issue-runner-bun}"
LAUNCHD_BINARY_PATH="${CODEX_RUNNER_BUN_LAUNCHD_BINARY:-$STATE_DIR/bin/codex-issue-runner-bun}"
LOG_DIR="${CODEX_RUNNER_BUN_LOG_DIR:-$STATE_DIR/logs}"
PATH_VALUE="${CODEX_RUNNER_BUN_PATH:-$PATH}"
PLIST="${CODEX_RUNNER_BUN_PLIST:-$HOME/Library/LaunchAgents/$LABEL.plist}"
DOMAIN="gui/$(id -u)"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      echo "usage: scripts/install-bun-launchd.sh [--dry-run]"
      exit 0
      ;;
    *)
      echo "[bun-launchd] unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  printf '%s' "$value"
}

normalize_path() {
  local path="$1" dir base
  [[ "$path" == /* ]] || path="$ROOT_DIR/$path"
  dir="$(dirname "$path")"
  base="$(basename "$path")"
  if [ -d "$dir" ]; then
    printf '%s/%s' "$(cd "$dir" && pwd -P)" "$base"
  else
    printf '%s/%s' "$dir" "$base"
  fi
}

fail_unsafe() {
  echo "[bun-launchd] unsafe Bun preview launchd config: $1" >&2
  exit 1
}

require_safe_config() {
  local build_binary db_path staged_binary
  [ "$LABEL" != "com.xiaobei.codex-issue-runner" ] || fail_unsafe "label must not use Go stable label"
  [ "${ADDR##*:}" != "3008" ] || fail_unsafe "addr must not use Go stable port 3008"
  build_binary="$(normalize_path "$BINARY_PATH")"
  [ "$build_binary" != "$(normalize_path "$ROOT_DIR/dist/codex-issue-runner")" ] || fail_unsafe "build binary must not overwrite Go stable binary"
  db_path="$(normalize_path "$DB_PATH")"
  [ "$db_path" != "$(normalize_path "$ROOT_DIR/data/runner.db")" ] || fail_unsafe "db must not point at Go stable data/ database"
  [ "$db_path" != "$(normalize_path "$ROOT_DIR/data/app.db")" ] || fail_unsafe "db must not point at Go stable data/ database"
  staged_binary="$(normalize_path "$LAUNCHD_BINARY_PATH")"
  [ "$staged_binary" != "$(normalize_path "$ROOT_DIR/dist/codex-issue-runner")" ] || fail_unsafe "staged binary must not overwrite Go stable binary"
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

write_plist() {
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
}

stage_bun_binary() {
  mkdir -p "$(dirname "$LAUNCHD_BINARY_PATH")"
  cp "$BINARY_PATH" "$LAUNCHD_BINARY_PATH"
  chmod +x "$LAUNCHD_BINARY_PATH"
  if [ -f "$BINARY_PATH.build.stamp" ]; then
    cp "$BINARY_PATH.build.stamp" "$LAUNCHD_BINARY_PATH.build.stamp"
  fi
}

write_custom_auth_token_file() {
  if [ -n "$AUTH_TOKEN" ]; then
    umask 077
    printf '%s\n' "$AUTH_TOKEN" > "$AUTH_TOKEN_FILE"
  fi
}

wait_for_health() {
  local url="$1" attempt
  for ((attempt = 1; attempt <= 120; attempt += 1)); do
    curl -fsS "$url/health" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

require_safe_config
if [ "$DRY_RUN" -eq 1 ] && [ -z "${CODEX_RUNNER_BUN_PLIST:-}" ]; then
  PLIST="$(mktemp "${TMPDIR:-/tmp}/codex-runner-bun.XXXXXX")"
fi

if [ "$DRY_RUN" -eq 0 ]; then
  "$ROOT_DIR/backend-ts/scripts/build-binary.sh"
  mkdir -p "$STATE_DIR" "$(dirname "$DB_PATH")" "$(dirname "$AUTH_TOKEN_FILE")" "$LOG_DIR" "$(dirname "$PLIST")"
  stage_bun_binary
  write_custom_auth_token_file
else
  mkdir -p "$(dirname "$PLIST")"
fi

write_plist
plutil -lint "$PLIST" >/dev/null

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[bun-launchd] dry-run plist: $PLIST"
  echo "[bun-launchd] label: $LABEL"
  echo "[bun-launchd] addr: $ADDR"
  echo "[bun-launchd] state-dir: $STATE_DIR"
  echo "[bun-launchd] db: $DB_PATH"
  echo "[bun-launchd] binary: $LAUNCHD_BINARY_PATH"
  echo "[bun-launchd] launchctl skipped"
  exit 0
fi

launchctl bootout "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
launchctl kickstart -k "$DOMAIN/$LABEL"
wait_for_health "$(service_url)"

"$ROOT_DIR/scripts/status-bun-launchd.sh"
echo "[bun-launchd] installed plist: $PLIST"
echo "[bun-launchd] binary: $LAUNCHD_BINARY_PATH"
echo "[bun-launchd] logs: $LOG_DIR/launchd.out.log $LOG_DIR/launchd.err.log"
