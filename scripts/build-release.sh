#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY_PATH="${CODEX_RUNNER_BINARY:-$ROOT_DIR/dist/codex-issue-runner}"
EMBED_WEB_DIR="$ROOT_DIR/backend/internal/web/dist"
API_PKG="github.com/xiaobei/codex-issue-runner/backend/internal/api"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[build] missing required command: $1" >&2
    exit 1
  fi
}

require_cmd go
require_cmd npm

resolve_app_version() {
  if [ -n "${CODEX_RUNNER_VERSION:-}" ]; then
    printf '%s' "$CODEX_RUNNER_VERSION"
    return
  fi
  if [ -n "${GITHUB_REF_NAME:-}" ]; then
    printf '%s' "$GITHUB_REF_NAME"
    return
  fi
  if command -v git >/dev/null 2>&1; then
    local tag
    tag="$(git -C "$ROOT_DIR" describe --tags --exact-match HEAD 2>/dev/null || true)"
    if [ -n "$tag" ]; then
      printf '%s' "$tag"
      return
    fi
  fi
  printf '0.0.0-dev'
}

resolve_build_stamp() {
  local revision dirty
  revision="nogit"
  dirty="clean"
  if command -v git >/dev/null 2>&1 && git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    revision="$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD 2>/dev/null || printf 'nogit')"
    if [ -n "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=normal -- . ':!dist' ':!frontend/dist')" ]; then
      dirty="dirty"
    fi
  fi
  printf '%s-%s-%s' "$(date -u '+%Y%m%dT%H%M%SZ')" "$revision" "$dirty"
}

ldflags_for_build() {
  printf '%s' "-X $API_PKG.appVersion=$APP_VERSION -X $API_PKG.buildStamp=$BUILD_STAMP"
}

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

APP_VERSION="$(resolve_app_version)"
BUILD_STAMP="$(resolve_build_stamp)"
echo "[build] building frontend ($APP_VERSION)..."
VITE_APP_VERSION="$APP_VERSION" npm --prefix "$ROOT_DIR/frontend" run build

mkdir -p "$(dirname "$BINARY_PATH")"
echo "[build] building single-binary release: $BINARY_PATH ($BUILD_STAMP)"
prepare_embedded_web
trap cleanup_embedded_web EXIT
(
  cd "$ROOT_DIR"
  go build -tags release -ldflags "$(ldflags_for_build)" \
    -o "$BINARY_PATH" ./backend/cmd/codex-issue-runner
)

# 针对 macOS 系统进行本地 Ad-Hoc 签名；本地 LaunchAgent 使用普通 ad-hoc
# 签名即可，避免 Hardened Runtime 下 launchd 启动卡在 dyld 早期。
if [[ "$OSTYPE" == "darwin"* ]]; then
  if command -v codesign >/dev/null 2>&1; then
    echo "[build] codesigning binary for macOS..."
    codesign --force --sign - "$BINARY_PATH"
  fi
fi

printf '%s\n' "$BUILD_STAMP" > "$BINARY_PATH.build.stamp"
echo "[build] done"
echo "[build] binary: $BINARY_PATH"
echo "[build] stamp: $BINARY_PATH.build.stamp"
echo "[build] web: embedded frontend/dist"
