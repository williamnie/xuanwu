#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="${CODEX_RUNNER_BUN_LAUNCHD_LABEL:-com.xiaobei.codex-issue-runner-bun}"
ADDR="${CODEX_RUNNER_BUN_ADDR:-127.0.0.1:3018}"
STATE_DIR="${CODEX_RUNNER_BUN_STATE_DIR:-$ROOT_DIR/data-bun}"
DB_PATH="${CODEX_RUNNER_BUN_DB:-$STATE_DIR/runner.db}"
AUTH_TOKEN_FILE="${CODEX_RUNNER_BUN_AUTH_TOKEN_FILE:-$STATE_DIR/auth_token}"
PLIST="${CODEX_RUNNER_BUN_PLIST:-$HOME/Library/LaunchAgents/$LABEL.plist}"
DOMAIN="gui/$(id -u)"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      echo "usage: scripts/status-bun-launchd.sh [--dry-run]"
      exit 0
      ;;
    *)
      echo "[bun-status] unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

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
  if [ -n "${CODEX_RUNNER_BUN_AUTH_TOKEN:-}" ]; then
    printf '%s' "$CODEX_RUNNER_BUN_AUTH_TOKEN"
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
      echo "[bun-status] system status not reachable"
      return
    }
    rm -f "$curl_config"
  elif ! curl -fsS "$url/api/system/status" -o "$status_file"; then
    rm -f "$status_file"
    echo "[bun-status] system status not reachable"
    return
  fi
  python3 - "$status_file" <<'PY' || echo "[bun-status] system status parse failed"
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    status = json.load(f)
service = status.get("service") or {}
build = service.get("build") or {}
print(f"[bun-status] runtime: {service.get('runtime') or 'unknown'}")
print(f"[bun-status] backend version: {service.get('version') or build.get('version') or 'unknown'}")
print(f"[bun-status] runtime stamp: {build.get('stamp') or 'missing'}")
print(f"[bun-status] db ok: {(status.get('db') or {}).get('ok')}")
PY
  rm -f "$status_file"
}

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[bun-status] dry-run label: $LABEL"
  echo "[bun-status] plist: $PLIST"
  echo "[bun-status] addr: $ADDR"
  echo "[bun-status] state-dir: $STATE_DIR"
  echo "[bun-status] db: $DB_PATH"
  exit 0
fi

echo "[bun-status] launchd label: $LABEL"
if launchctl print "$DOMAIN/$LABEL" >/tmp/codex-issue-runner-bun.launchd.$$.txt 2>/dev/null; then
  awk '/state =|pid =|last exit code =/ { print "[bun-status] " $0 }' \
    /tmp/codex-issue-runner-bun.launchd.$$.txt || true
  rm -f /tmp/codex-issue-runner-bun.launchd.$$.txt
else
  rm -f /tmp/codex-issue-runner-bun.launchd.$$.txt
  echo "[bun-status] launchd service is not loaded"
fi

PORT="${ADDR##*:}"
echo "[bun-status] listening sockets for port $PORT:"
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN || true

URL="$(service_url)"
echo "[bun-status] health check: $URL/health"
if curl -fsS "$URL/health" >/dev/null; then
  echo "[bun-status] API OK"
else
  echo "[bun-status] API not reachable"
  exit 1
fi
print_system_status "$URL"
