#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="${CODEX_RUNNER_LAUNCHD_LABEL:-com.xiaobei.codex-issue-runner}"
ADDR="${CODEX_RUNNER_ADDR:-0.0.0.0:3008}"
DB_PATH="${CODEX_RUNNER_DEPLOY_DB:-$ROOT_DIR/data/app.db}"
AUTH_TOKEN_FILE="${CODEX_RUNNER_AUTH_TOKEN_FILE:-$(dirname "$DB_PATH")/auth_token}"
DOMAIN="gui/$(id -u)"

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

api_token() {
  if [ -n "${CODEX_RUNNER_AUTH_TOKEN:-}" ]; then
    printf '%s' "$CODEX_RUNNER_AUTH_TOKEN"
    return
  fi
  if [ -f "$AUTH_TOKEN_FILE" ]; then
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
      rm -f "$curl_config"
      rm -f "$status_file"
      echo "[status] system status not reachable"
      return
    }
    rm -f "$curl_config"
  elif ! curl -fsS "$url/api/system/status" -o "$status_file"; then
    rm -f "$status_file"
    echo "[status] system status not reachable"
    return
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    rm -f "$status_file"
    echo "[status] system status parse skipped: python3 not found"
    return
  fi
  if ! python3 - "$status_file" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    status = json.load(f)
service = status.get("service") or {}
build = service.get("build") or {}
version = service.get("version") or build.get("version") or "unknown"
stamp = build.get("stamp") or "missing"
dist_status = build.get("dist_stamp_status") or "not_checked"
print(f"[status] backend version: {version}")
print(f"[status] runtime stamp: {stamp}")
print(f"[status] dist stamp status: {dist_status}")
PY
  then
    echo "[status] system status parse failed"
  fi
  rm -f "$status_file"
}

echo "[status] launchd label: $LABEL"
if launchctl print "$DOMAIN/$LABEL" >/tmp/codex-issue-runner.launchd.$$.txt 2>/dev/null; then
  awk '/state =|pid =|last exit code =/ { print "[status] " $0 }' \
    /tmp/codex-issue-runner.launchd.$$.txt || true
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
