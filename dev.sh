#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_ADDR="${XUANWU_DEV_ADDR:-127.0.0.1:3569}"
STATE_DIR="${XUANWU_STATE_DIR:-$ROOT_DIR/data-bun}"
DB_PATH="${XUANWU_DB:-$STATE_DIR/runner.db}"
AUTH_TOKEN_FILE="${XUANWU_AUTH_TOKEN_FILE:-$STATE_DIR/auth_token}"
FRONTEND_HOST="${FRONTEND_HOST:-0.0.0.0}"
FRONTEND_PORT="${FRONTEND_PORT:-3568}"

BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  trap - EXIT INT TERM
  echo
  echo "[dev] stopping services..."
  if [ -n "$FRONTEND_PID" ]; then kill "$FRONTEND_PID" 2>/dev/null || true; fi
  if [ -n "$BACKEND_PID" ]; then kill "$BACKEND_PID" 2>/dev/null || true; fi
  if [ -n "$FRONTEND_PID" ]; then wait "$FRONTEND_PID" 2>/dev/null || true; fi
  if [ -n "$BACKEND_PID" ]; then wait "$BACKEND_PID" 2>/dev/null || true; fi
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[dev] missing required command: $1" >&2
    exit 1
  fi
}

backend_api_target() {
  local host port url_host
  host="${1%:*}"
  port="${1##*:}"
  case "$host" in
    "" | "0.0.0.0" | "::" | "[::]")
      host="127.0.0.1"
      ;;
  esac
  url_host="$host"
  if [[ "$url_host" == *:* && "$url_host" != \[*\] ]]; then
    url_host="[$url_host]"
  fi
  printf 'http://%s:%s\n' "$url_host" "$port"
}

BACKEND_API_ADDR="$(backend_api_target "$BACKEND_ADDR")"
FRONTEND_API_TARGET="${VITE_API_TARGET:-$BACKEND_API_ADDR}"

require_cmd bun
require_cmd npm

if [ ! -d "$ROOT_DIR/backend-ts/node_modules" ]; then
  echo "[dev] backend-ts/node_modules not found, running bun install..."
  (cd "$ROOT_DIR/backend-ts" && bun install)
fi

if [ ! -d "$ROOT_DIR/frontend/node_modules" ]; then
  echo "[dev] frontend/node_modules not found, running npm install..."
  npm --prefix "$ROOT_DIR/frontend" install
fi

mkdir -p "$STATE_DIR" "$(dirname "$DB_PATH")" "$(dirname "$AUTH_TOKEN_FILE")"

trap cleanup EXIT INT TERM

echo "[dev] backend  http://$BACKEND_ADDR"
echo "[dev] frontend http://$FRONTEND_HOST:$FRONTEND_PORT"
echo "[dev] api proxy $FRONTEND_API_TARGET"
echo "[dev] runner  $BACKEND_API_ADDR"
echo "[dev] state    $STATE_DIR"
echo "[dev] database $DB_PATH"
echo "[dev] press Ctrl+C to stop both services"
echo

(
  cd "$ROOT_DIR/backend-ts"
  export XUANWU_ADDR="$BACKEND_API_ADDR"
  bun run src/main.ts serve \
    --addr "$BACKEND_ADDR" \
    --state-dir "$STATE_DIR" \
    --db "$DB_PATH" \
    --auth-token-file "$AUTH_TOKEN_FILE"
) &
BACKEND_PID=$!

(
  cd "$ROOT_DIR/frontend"
  export VITE_API_TARGET="$FRONTEND_API_TARGET"
  npm run dev -- --host "$FRONTEND_HOST" --port "$FRONTEND_PORT"
) &
FRONTEND_PID=$!

while kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$FRONTEND_PID" 2>/dev/null; do
  sleep 1
done

BACKEND_STATUS=0
FRONTEND_STATUS=0
wait "$BACKEND_PID" 2>/dev/null || BACKEND_STATUS=$?
wait "$FRONTEND_PID" 2>/dev/null || FRONTEND_STATUS=$?

if [ "$BACKEND_STATUS" -ne 0 ]; then
  echo "[dev] backend exited with status $BACKEND_STATUS" >&2
fi
if [ "$FRONTEND_STATUS" -ne 0 ]; then
  echo "[dev] frontend exited with status $FRONTEND_STATUS" >&2
fi

exit $(( BACKEND_STATUS != 0 ? BACKEND_STATUS : FRONTEND_STATUS ))
