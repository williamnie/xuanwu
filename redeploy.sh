#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADDR="${CODEX_RUNNER_ADDR:-0.0.0.0:3008}"
DB_PATH="${CODEX_RUNNER_DEPLOY_DB:-$ROOT_DIR/data/app.db}"
AUTH_TOKEN_FILE="${CODEX_RUNNER_AUTH_TOKEN_FILE:-$(dirname "$DB_PATH")/auth_token}"

log() {
  printf '[redeploy] %s\n' "$*"
}

service_url() {
  if [[ "$ADDR" == 0.0.0.0:* ]]; then
    printf 'http://127.0.0.1:%s' "${ADDR##*:}"
    return
  fi
  if [[ "$ADDR" == :* ]]; then
    printf 'http://127.0.0.1%s' "$ADDR"
    return
  fi
  printf 'http://%s' "$ADDR"
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

curl_api() {
  local url="$1"
  local output="$2"
  local token curl_config curl_status
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
  local status_file="$1"
  python3 - "$status_file" <<'PY'
import json, sys

with open(sys.argv[1], encoding="utf-8") as f:
    status = json.load(f)

service = status.get("service") or {}
build = service.get("build") or {}
version = service.get("version") or build.get("version") or "unknown"
stamp = build.get("stamp") or "missing"
dist_status = build.get("dist_stamp_status") or "not_checked"

print(f"[redeploy] backend version: {version}")
print(f"[redeploy] runtime stamp: {stamp}")
print(f"[redeploy] dist stamp status: {dist_status}")
PY
}

verify_live_service() {
  local url="$1"
  local status_file projects_file
  status_file="$(mktemp)"
  projects_file="$(mktemp)"

  curl -fsS "$url/health" >/dev/null
  curl_api "$url/api/system/status" "$status_file"
  print_build_summary "$status_file"
  curl_api "$url/api/projects" "$projects_file"
  rm -f "$status_file" "$projects_file"
  log "verified: health, system status, projects API"
}

main() {
  log "building and restarting launchd service..."
  "$ROOT_DIR/deploy.sh" "$@"

  local url
  url="$(service_url)"
  log "verifying live service at $url ..."
  verify_live_service "$url"
  log "done: $url"
}

main "$@"
