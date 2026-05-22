#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY_PATH="${CODEX_RUNNER_BINARY:-$ROOT_DIR/dist/codex-issue-runner}"
EMBED_WEB_DIR="$ROOT_DIR/backend/internal/web/dist"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[build] missing required command: $1" >&2
    exit 1
  fi
}

require_cmd go
require_cmd npm

prepare_embedded_web() {
  rm -rf "$EMBED_WEB_DIR"
  mkdir -p "$EMBED_WEB_DIR"
  cp -R "$ROOT_DIR/frontend/dist/." "$EMBED_WEB_DIR/"
}

cleanup_embedded_web() {
  rm -rf "$EMBED_WEB_DIR"
}

install_frontend_deps() {
  if [ -d "$ROOT_DIR/frontend/node_modules" ]; then
    return
  fi
  if [ -f "$ROOT_DIR/frontend/package-lock.json" ]; then
    echo "[build] frontend/node_modules not found, running npm ci..."
    if npm --prefix "$ROOT_DIR/frontend" ci; then
      return
    fi
    echo "[build] npm ci failed, falling back to npm install..." >&2
  fi
  echo "[build] frontend/node_modules not found, running npm install..."
  npm --prefix "$ROOT_DIR/frontend" install
}

install_frontend_deps

echo "[build] building frontend..."
npm --prefix "$ROOT_DIR/frontend" run build

mkdir -p "$(dirname "$BINARY_PATH")"
echo "[build] building single-binary release: $BINARY_PATH"
prepare_embedded_web
trap cleanup_embedded_web EXIT
(
  cd "$ROOT_DIR"
  go build -tags release -o "$BINARY_PATH" ./backend/cmd/codex-issue-runner
)

# 针对 macOS 系统进行本地 Ad-Hoc 签名，并启用 Hardened Runtime。
if [[ "$OSTYPE" == "darwin"* ]]; then
  if command -v codesign >/dev/null 2>&1; then
    echo "[build] codesigning binary for macOS..."
    codesign --force --options runtime --sign - "$BINARY_PATH"
  fi
fi

echo "[build] done"
echo "[build] binary: $BINARY_PATH"
echo "[build] web: embedded frontend/dist"
