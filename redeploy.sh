#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADDR="${CODEX_RUNNER_ADDR:-0.0.0.0:3008}"
APP_SUPPORT_DIR="${CODEX_RUNNER_APP_SUPPORT_DIR:-$HOME/Library/Application Support/codex-issue-runner-bun-live}"
STATE_DIR="${CODEX_RUNNER_STATE_DIR:-$APP_SUPPORT_DIR/state}"
AUTH_TOKEN_FILE="${CODEX_RUNNER_AUTH_TOKEN_FILE:-$STATE_DIR/auth_token}"

log() { printf '[redeploy] %s\n' "$*"; }

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

curl_api() {
  local url="$1" output="$2" token curl_config curl_status
  token="$(api_token)"
  if [ -z "$token" ]; then
    curl -fsS "$url" -o "$output"
    return
  fi
  curl_config="$(mktemp)"
  chmod 600 "$curl_config"
  printf 'header = "Authorization: Bearer %s"\n' "$token" > "$curl_config"
  if curl -fsS --config "$curl_config" "$url" -o "$output"; then
    rm -f "$curl_config"
    return 0
  fi
  curl_status=$?
  rm -f "$curl_config"
  return "$curl_status"
}

print_build_summary() {
  python3 - "$1" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    status = json.load(f)
service = status.get("service") or {}
build = service.get("build") or {}
print(f"[redeploy] runtime: {service.get('runtime') or 'unknown'}")
print(f"[redeploy] backend version: {service.get('version') or build.get('version') or 'unknown'}")
print(f"[redeploy] runtime stamp: {build.get('stamp') or 'missing'}")
PY
}

verify_live_service() {
  local url="$1" status_file projects_file
  status_file="$(mktemp)"
  projects_file="$(mktemp)"
  curl -fsS "$url/health" >/dev/null
  curl_api "$url/api/system/status" "$status_file"
  print_build_summary "$status_file"
  curl_api "$url/api/projects" "$projects_file"
  rm -f "$status_file" "$projects_file"
  log "verified: health, system status, projects API"
}

log "building and restarting Bun live service..."
"$ROOT_DIR/deploy.sh" "$@"
url="$(service_url)"
log "verifying live service at $url ..."
verify_live_service "$url"
log "done: $url"
