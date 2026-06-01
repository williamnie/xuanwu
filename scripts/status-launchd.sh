#!/usr/bin/env bash
set -euo pipefail

LABEL="${CODEX_RUNNER_LAUNCHD_LABEL:-com.xiaobei.codex-issue-runner}"
ADDR="${CODEX_RUNNER_ADDR:-0.0.0.0:3008}"
APP_SUPPORT_DIR="${CODEX_RUNNER_APP_SUPPORT_DIR:-$HOME/Library/Application Support/codex-issue-runner-bun-live}"
STATE_DIR="${CODEX_RUNNER_STATE_DIR:-$APP_SUPPORT_DIR/state}"
AUTH_TOKEN_FILE="${CODEX_RUNNER_AUTH_TOKEN_FILE:-$STATE_DIR/auth_token}"
DOMAIN="gui/$(id -u)"

service_url() {
  if [[ "$ADDR" == 0.0.0.0:* ]]; then
    printf 'http://127.0.0.1:%s' "${ADDR##*:}"
  elif [[ "$ADDR" == :* ]]; then
    printf 'http://127.0.0.1%s' "$ADDR"
  else
    printf 'http://%s' "$ADDR"
  fi
}

api_token() {
  if [ -n "${CODEX_RUNNER_AUTH_TOKEN:-}" ]; then
    printf '%s' "$CODEX_RUNNER_AUTH_TOKEN"
  elif [ -f "$AUTH_TOKEN_FILE" ]; then
    tr -d '\n' < "$AUTH_TOKEN_FILE"
  fi
}

print_system_status() {
  local url="$1" token status_file curl_config
  token="$(api_token)"
  status_file="$(mktemp)"
  if [ -n "$token" ]; then
    curl_config="$(mktemp)"
    chmod 600 "$curl_config"
    printf 'header = "Authorization: Bearer %s"\n' "$token" > "$curl_config"
    curl -fsS --config "$curl_config" "$url/api/system/status" -o "$status_file" || {
      rm -f "$curl_config" "$status_file"
      echo "[status] system status not reachable"
      return
    }
    rm -f "$curl_config"
  elif ! curl -fsS "$url/api/system/status" -o "$status_file"; then
    rm -f "$status_file"
    echo "[status] system status not reachable"
    return
  fi
  python3 - "$status_file" <<'PY' || echo "[status] system status parse failed"
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    status = json.load(f)
service = status.get("service") or {}
build = service.get("build") or {}
print(f"[status] runtime: {service.get('runtime') or 'unknown'}")
print(f"[status] backend version: {service.get('version') or build.get('version') or 'unknown'}")
print(f"[status] runtime stamp: {build.get('stamp') or 'missing'}")
print(f"[status] db ok: {(status.get('db') or {}).get('ok')}")
PY
  rm -f "$status_file"
}

echo "[status] launchd label: $LABEL"
if launchctl print "$DOMAIN/$LABEL" >/tmp/codex-issue-runner.launchd.$$.txt 2>/dev/null; then
  awk '/state =|pid =|last exit code =/ { print "[status] " $0 }' /tmp/codex-issue-runner.launchd.$$.txt || true
  rm -f /tmp/codex-issue-runner.launchd.$$.txt
else
  rm -f /tmp/codex-issue-runner.launchd.$$.txt
  echo "[status] launchd service is not loaded"
fi

PORT="${ADDR##*:}"
echo "[status] listening sockets for port $PORT:"
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN || true

URL="$(service_url)"
echo "[status] health check: $URL/health"
if curl -fsS "$URL/health" >/dev/null; then
  echo "[status] API OK"
else
  echo "[status] API not reachable"
  exit 1
fi
print_system_status "$URL"
