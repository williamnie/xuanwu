#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_ADDR="${CODEX_RUNNER_ADDR:-0.0.0.0:3008}"
STATE_DIR="${CODEX_RUNNER_STATE_DIR:-$ROOT_DIR/data-bun}"
DB_PATH="${CODEX_RUNNER_DB:-$STATE_DIR/runner.db}"
AUTH_TOKEN_FILE="${CODEX_RUNNER_AUTH_TOKEN_FILE:-$STATE_DIR/auth_token}"
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
echo "[dev] state    $STATE_DIR"
echo "[dev] database $DB_PATH"
echo "[dev] press Ctrl+C to stop both services"
echo

(
  cd "$ROOT_DIR/backend-ts"
  bun run src/main.ts serve \
    --addr "$BACKEND_ADDR" \
    --state-dir "$STATE_DIR" \
    --db "$DB_PATH" \
    --auth-token-file "$AUTH_TOKEN_FILE"
) &
BACKEND_PID=$!

(
  cd "$ROOT_DIR/frontend"
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
