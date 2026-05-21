#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY_PATH="${CODEX_RUNNER_BINARY:-$ROOT_DIR/dist/codex-issue-runner}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[build] missing required command: $1" >&2
    exit 1
  fi
}

require_cmd go
require_cmd npm

if [ ! -d "$ROOT_DIR/frontend/node_modules" ]; then
  echo "[build] frontend/node_modules not found, running npm install..."
  npm --prefix "$ROOT_DIR/frontend" install
fi

echo "[build] building frontend..."
npm --prefix "$ROOT_DIR/frontend" run build

mkdir -p "$(dirname "$BINARY_PATH")"
echo "[build] building backend binary: $BINARY_PATH"
(
  cd "$ROOT_DIR"
  go build -o "$BINARY_PATH" ./backend/cmd/codex-issue-runner
)

echo "[build] done"
echo "[build] binary: $BINARY_PATH"
echo "[build] web dir: $ROOT_DIR/frontend/dist"
