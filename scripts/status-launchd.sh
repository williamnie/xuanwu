#!/usr/bin/env bash
set -euo pipefail

LABEL="${XUANWU_LAUNCHD_LABEL:-com.xiaobei.xuanwu}"
WEB_LABEL="${LABEL}.web"
CORE_LABEL="${LABEL}.core"
AGENTIC_LABEL="${LABEL}.agentic"
ADDR="${XUANWU_ADDR:-0.0.0.0:3008}"
CORE_ADDR="${XUANWU_CORE_ADDR:-127.0.0.1:3009}"
AGENTIC_ADDR="${XUANWU_AGENTIC_ADDR:-127.0.0.1:3010}"
APP_SUPPORT_DIR="${XUANWU_APP_SUPPORT_DIR:-$HOME/Library/Application Support/xuanwu-bun-live}"
STATE_DIR="${XUANWU_STATE_DIR:-$APP_SUPPORT_DIR/state}"
DB_PATH="${XUANWU_DB:-${XUANWU_DEPLOY_DB:-$STATE_DIR/runner.db}}"
AUTH_TOKEN_FILE="${XUANWU_AUTH_TOKEN_FILE:-$STATE_DIR/auth_token}"
LAUNCHD_BINARY_PATH="${XUANWU_LAUNCHD_BINARY:-$APP_SUPPORT_DIR/bin/xuanwu}"
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
  if [ -n "${XUANWU_AUTH_TOKEN:-}" ]; then
    printf '%s' "$XUANWU_AUTH_TOKEN"
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

curl_core_api() {
  local url="$1" path="$2" output="$3" token config
  token="$(api_token)"
  if [ -z "$token" ]; then
    curl -fsS "$url$path" -o "$output"
    return
  fi
  config="$(mktemp)"
  chmod 600 "$config"
  printf 'header = "Authorization: Bearer %s"\n' "$token" > "$config"
  curl -fsS --config "$config" "$url$path" -o "$output"
  rm -f "$config"
}

curl_core_status() {
  curl_core_api "$1" "/api/system/status?compact=1" "$2"
}

WEB_URL="$(service_url "$ADDR")"
CORE_URL="$(service_url "$CORE_ADDR")"
print_launchd_service "$WEB_LABEL"
print_launchd_service "$CORE_LABEL"
print_launchd_service "$AGENTIC_LABEL"

WEB_PID="$(service_pid "$WEB_LABEL")"
CORE_PID="$(service_pid "$CORE_LABEL")"
AGENTIC_PID="$(service_pid "$AGENTIC_LABEL")"
[ -n "$WEB_PID" ] && [ -n "$CORE_PID" ] && [ -n "$AGENTIC_PID" ] \
  || { echo "[status] Web, Core, and Agentic services are not all running" >&2; exit 1; }
[ "$WEB_PID" != "$CORE_PID" ] && [ "$WEB_PID" != "$AGENTIC_PID" ] && [ "$CORE_PID" != "$AGENTIC_PID" ] \
  || { echo "[status] Web, Core, and Agentic unexpectedly share a PID" >&2; exit 1; }
WEB_COMMAND="$(ps -p "$WEB_PID" -o command=)"
CORE_COMMAND="$(ps -p "$CORE_PID" -o command=)"
AGENTIC_COMMAND="$(ps -p "$AGENTIC_PID" -o command=)"
[[ "$WEB_COMMAND" == *"$LAUNCHD_BINARY_PATH"*"--role web"* ]] \
  || { echo "[status] Web PID is not the expected artifact/role" >&2; exit 1; }
[[ "$CORE_COMMAND" == *"$LAUNCHD_BINARY_PATH"*"--role core"* ]] \
  || { echo "[status] Core PID is not the expected artifact/role" >&2; exit 1; }
[[ "$AGENTIC_COMMAND" == *"$LAUNCHD_BINARY_PATH"*"--role agentic"* ]] \
  || { echo "[status] Agentic PID is not the expected artifact/role" >&2; exit 1; }

for addr in "$ADDR" "$CORE_ADDR" "$AGENTIC_ADDR"; do
  port="${addr##*:}"
  echo "[status] listening sockets for port $port:"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN || true
done

echo "[status] web health: $WEB_URL/health"
curl -fsS "$WEB_URL/health" >/dev/null
echo "[status] core health: $CORE_URL/health"
curl -fsS "$CORE_URL/health" >/dev/null
AGENTIC_URL="$(service_url "$AGENTIC_ADDR")"
echo "[status] agentic health: $AGENTIC_URL/health"
curl -fsS "$AGENTIC_URL/health" >/dev/null

STATUS_FILE="$(mktemp)"
GATEWAY_STATUS_FILE="$(mktemp)"
AGENTIC_STATUS_FILE="$(mktemp)"
trap 'rm -f "$STATUS_FILE" "$GATEWAY_STATUS_FILE" "$AGENTIC_STATUS_FILE"' EXIT
curl_core_status "$CORE_URL" "$STATUS_FILE"
curl_core_status "$WEB_URL" "$GATEWAY_STATUS_FILE"
curl_core_api "$CORE_URL" "/api/system/agentic-health" "$AGENTIC_STATUS_FILE"
python3 - "$STATUS_FILE" "$GATEWAY_STATUS_FILE" "$LAUNCHD_BINARY_PATH.build.stamp" "$AGENTIC_STATUS_FILE" <<'PY'
import json, pathlib, sys
with open(sys.argv[1], encoding="utf-8") as f:
    status = json.load(f)
with open(sys.argv[2], encoding="utf-8") as f:
    gateway_status = json.load(f)
with open(sys.argv[4], encoding="utf-8") as f:
    agentic_status = json.load(f)
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
print(f"[status] core -> agentic RPC ok: {agentic_status.get('ok')}")
if service.get("role") != "core":
    raise SystemExit("core status did not report role=core")
if gateway_service.get("role") != "core" or gateway_build.get("stamp") != runtime_stamp:
    raise SystemExit("Web Gateway did not proxy the matching Core runtime")
if not runtime_stamp or runtime_stamp != artifact_stamp:
    raise SystemExit("runtime/artifact stamp mismatch")
if not (status.get("db") or {}).get("ok"):
    raise SystemExit("core database check failed")
if agentic_status.get("ok") is not True or agentic_status.get("role") != "agentic":
    raise SystemExit("Core did not reach the matching Agentic Worker")
PY

if lsof -nP -a -p "$WEB_PID" "$DB_PATH" 2>/dev/null | grep -F "$DB_PATH" >/dev/null; then
  echo "[status] Web process opened runner DB: $DB_PATH" >&2
  exit 1
fi
if ! lsof -nP -a -p "$CORE_PID" "$DB_PATH" 2>/dev/null | grep -F "$DB_PATH" >/dev/null; then
  echo "[status] Core process does not hold runner DB: $DB_PATH" >&2
  exit 1
fi
if ! lsof -nP -a -p "$AGENTIC_PID" "$DB_PATH" 2>/dev/null | grep -F "$DB_PATH" >/dev/null; then
  echo "[status] Agentic process does not hold runner DB: $DB_PATH" >&2
  exit 1
fi
echo "[status] split authority: web_pid=$WEB_PID core_pid=$CORE_PID agentic_pid=$AGENTIC_PID guardian=core provider=core connector=core background_llm=agentic sqlite=shared-file-serialized-writes"
echo "[status] API OK via Web Gateway"
