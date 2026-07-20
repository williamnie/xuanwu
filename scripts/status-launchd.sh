#!/usr/bin/env bash
set -euo pipefail

LABEL="${CODEX_RUNNER_LAUNCHD_LABEL:-com.xiaobei.codex-issue-runner}"
WEB_LABEL="${LABEL}.web"
CORE_LABEL="${LABEL}.core"
ADDR="${CODEX_RUNNER_ADDR:-0.0.0.0:3008}"
CORE_ADDR="${CODEX_RUNNER_CORE_ADDR:-127.0.0.1:3009}"
APP_SUPPORT_DIR="${CODEX_RUNNER_APP_SUPPORT_DIR:-$HOME/Library/Application Support/codex-issue-runner-bun-live}"
STATE_DIR="${CODEX_RUNNER_STATE_DIR:-$APP_SUPPORT_DIR/state}"
DB_PATH="${CODEX_RUNNER_DB:-${CODEX_RUNNER_DEPLOY_DB:-$STATE_DIR/runner.db}}"
AUTH_TOKEN_FILE="${CODEX_RUNNER_AUTH_TOKEN_FILE:-$STATE_DIR/auth_token}"
LAUNCHD_BINARY_PATH="${CODEX_RUNNER_LAUNCHD_BINARY:-$APP_SUPPORT_DIR/bin/codex-issue-runner}"
DOMAIN="gui/$(id -u)"

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

api_token() {
  if [ -n "${CODEX_RUNNER_AUTH_TOKEN:-}" ]; then
    printf '%s' "$CODEX_RUNNER_AUTH_TOKEN"
  elif [ -f "$AUTH_TOKEN_FILE" ]; then
    tr -d '\n' < "$AUTH_TOKEN_FILE"
  fi
}

service_pid() {
  launchctl print "$DOMAIN/$1" 2>/dev/null | awk '/^[[:space:]]*pid =/ { print $3; exit }'
}

print_launchd_service() {
  local label="$1" output
  output="$(mktemp)"
  echo "[status] launchd label: $label"
  if launchctl print "$DOMAIN/$label" >"$output" 2>/dev/null; then
    awk '/state =|pid =|last exit code =/ { print "[status] " $0 }' "$output" || true
  else
    echo "[status] launchd service is not loaded"
  fi
  rm -f "$output"
}

curl_core_status() {
  local url="$1" output="$2" token config
  token="$(api_token)"
  if [ -z "$token" ]; then
    curl -fsS "$url/api/system/status?compact=1" -o "$output"
    return
  fi
  config="$(mktemp)"
  chmod 600 "$config"
  printf 'header = "Authorization: Bearer %s"\n' "$token" > "$config"
  curl -fsS --config "$config" "$url/api/system/status?compact=1" -o "$output"
  rm -f "$config"
}

WEB_URL="$(service_url "$ADDR")"
CORE_URL="$(service_url "$CORE_ADDR")"
print_launchd_service "$WEB_LABEL"
print_launchd_service "$CORE_LABEL"

WEB_PID="$(service_pid "$WEB_LABEL")"
CORE_PID="$(service_pid "$CORE_LABEL")"
[ -n "$WEB_PID" ] && [ -n "$CORE_PID" ] || { echo "[status] split services are not both running" >&2; exit 1; }
[ "$WEB_PID" != "$CORE_PID" ] || { echo "[status] Web and Core unexpectedly share one PID" >&2; exit 1; }
WEB_COMMAND="$(ps -p "$WEB_PID" -o command=)"
CORE_COMMAND="$(ps -p "$CORE_PID" -o command=)"
[[ "$WEB_COMMAND" == *"$LAUNCHD_BINARY_PATH"*"--role web"* ]] \
  || { echo "[status] Web PID is not the expected artifact/role" >&2; exit 1; }
[[ "$CORE_COMMAND" == *"$LAUNCHD_BINARY_PATH"*"--role core"* ]] \
  || { echo "[status] Core PID is not the expected artifact/role" >&2; exit 1; }

for addr in "$ADDR" "$CORE_ADDR"; do
  port="${addr##*:}"
  echo "[status] listening sockets for port $port:"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN || true
done

echo "[status] web health: $WEB_URL/health"
curl -fsS "$WEB_URL/health" >/dev/null
echo "[status] core health: $CORE_URL/health"
curl -fsS "$CORE_URL/health" >/dev/null

STATUS_FILE="$(mktemp)"
GATEWAY_STATUS_FILE="$(mktemp)"
trap 'rm -f "$STATUS_FILE" "$GATEWAY_STATUS_FILE"' EXIT
curl_core_status "$CORE_URL" "$STATUS_FILE"
curl_core_status "$WEB_URL" "$GATEWAY_STATUS_FILE"
python3 - "$STATUS_FILE" "$GATEWAY_STATUS_FILE" "$LAUNCHD_BINARY_PATH.build.stamp" <<'PY'
import json, pathlib, sys
with open(sys.argv[1], encoding="utf-8") as f:
    status = json.load(f)
with open(sys.argv[2], encoding="utf-8") as f:
    gateway_status = json.load(f)
service = status.get("service") or {}
build = service.get("build") or {}
gateway_service = gateway_status.get("service") or {}
gateway_build = gateway_service.get("build") or {}
stamp_file = pathlib.Path(sys.argv[3])
artifact_stamp = stamp_file.read_text(encoding="utf-8").strip() if stamp_file.exists() else ""
runtime_stamp = build.get("stamp") or ""
print(f"[status] runtime: {service.get('runtime') or 'unknown'}")
print(f"[status] core role: {service.get('role') or 'unknown'}")
print(f"[status] backend version: {service.get('version') or build.get('version') or 'unknown'}")
print(f"[status] runtime stamp: {runtime_stamp or 'missing'}")
print(f"[status] artifact stamp: {artifact_stamp or 'missing'}")
print(f"[status] db ok: {(status.get('db') or {}).get('ok')}")
if service.get("role") != "core":
    raise SystemExit("core status did not report role=core")
if gateway_service.get("role") != "core" or gateway_build.get("stamp") != runtime_stamp:
    raise SystemExit("Web Gateway did not proxy the matching Core runtime")
if not runtime_stamp or runtime_stamp != artifact_stamp:
    raise SystemExit("runtime/artifact stamp mismatch")
if not (status.get("db") or {}).get("ok"):
    raise SystemExit("core database check failed")
PY

if lsof -nP -a -p "$WEB_PID" "$DB_PATH" 2>/dev/null | grep -F "$DB_PATH" >/dev/null; then
  echo "[status] Web process opened runner DB: $DB_PATH" >&2
  exit 1
fi
if ! lsof -nP -a -p "$CORE_PID" "$DB_PATH" 2>/dev/null | grep -F "$DB_PATH" >/dev/null; then
  echo "[status] Core process does not hold runner DB: $DB_PATH" >&2
  exit 1
fi
echo "[status] split authority: web_pid=$WEB_PID core_pid=$CORE_PID db_writer=core scheduler=core provider=core connector=core"
echo "[status] API OK via Web Gateway"
