#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${CODEX_RUNNER_RELEASE_DIR:-$ROOT_DIR/dist/release}"
WORK_DIR="$OUT_DIR/.work"
EMBED_WEB_DIR="$ROOT_DIR/backend/internal/web/dist"
LDFLAGS="${CODEX_RUNNER_LDFLAGS:--s -w}"
DEFAULT_TARGETS=(darwin/arm64 darwin/amd64 linux/arm64 linux/amd64)
APP_VERSION=""

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[release] missing required command: $1" >&2
    exit 1
  fi
}

log() {
  printf '[release] %s\n' "$*"
}

fail() {
  printf '[release] ERROR: %s\n' "$*" >&2
  exit 1
}

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

frontend_install() {
  if [ -d "$ROOT_DIR/frontend/node_modules" ]; then
    return
  fi
  if [ -f "$ROOT_DIR/frontend/package-lock.json" ]; then
    if npm --prefix "$ROOT_DIR/frontend" ci; then
      return
    fi
    echo "[release] npm ci failed, falling back to npm install..." >&2
  fi
  npm --prefix "$ROOT_DIR/frontend" install
}

run_step() {
  local label="$1"
  shift
  log "preflight: $label"
  if ! "$@"; then
    fail "$label failed"
  fi
}

run_preflight_checks() {
  run_step "go test ./backend/..." go test ./backend/...
  frontend_install
  run_step "frontend lint" npm --prefix "$ROOT_DIR/frontend" run lint
  APP_VERSION="$(resolve_app_version)"
  log "frontend version: $APP_VERSION"
  run_step "frontend build" env VITE_APP_VERSION="$APP_VERSION" npm --prefix "$ROOT_DIR/frontend" run build
  log "preflight summary: backend tests, frontend lint, frontend build"
}

prepare_embedded_web() {
  rm -rf "$EMBED_WEB_DIR"
  mkdir -p "$EMBED_WEB_DIR"
  cp -R "$ROOT_DIR/frontend/dist/." "$EMBED_WEB_DIR/"
}

cleanup_embedded_web() {
  rm -rf "$EMBED_WEB_DIR"
}

cleanup_all() {
  cleanup_embedded_web
  rm -rf "$WORK_DIR"
}

package_target() {
  local target="$1"
  local goos="${target%/*}"
  local goarch="${target#*/}"
  local asset="codex-issue-runner_${goos}_${goarch}"
  local pkg_dir="$WORK_DIR/$asset"
  rm -rf "$pkg_dir"
  mkdir -p "$pkg_dir"
  echo "[release] building $target"
  (
    cd "$ROOT_DIR"
    CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
      go build -tags release -trimpath -ldflags "$LDFLAGS" \
      -o "$pkg_dir/codex-issue-runner" ./backend/cmd/codex-issue-runner
  )
  cp "$ROOT_DIR/README.md" "$pkg_dir/README.md"
  cp "$ROOT_DIR/scripts/install-release.sh" "$pkg_dir/install-release.sh"
  (cd "$pkg_dir" && LC_ALL=C tar -czf "$OUT_DIR/$asset.tar.gz" .)
}

verify_release_artifacts() {
  local targets=("$@")
  local target goos goarch asset
  for target in "${targets[@]}"; do
    goos="${target%/*}"
    goarch="${target#*/}"
    asset="codex-issue-runner_${goos}_${goarch}.tar.gz"
    [ -s "$OUT_DIR/$asset" ] || fail "missing or empty release asset: $asset"
  done
  [ -s "$OUT_DIR/checksums.txt" ] || fail "missing or empty release checksum file: checksums.txt"
  log "artifact summary: ${#targets[@]} tarballs plus checksums.txt"
}

write_checksums() {
  (
    cd "$OUT_DIR"
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum *.tar.gz > checksums.txt
    else
      shasum -a 256 *.tar.gz > checksums.txt
    fi
  )
}

main() {
  require_cmd go
  require_cmd npm
  require_cmd tar
  rm -rf "$OUT_DIR"
  mkdir -p "$OUT_DIR" "$WORK_DIR"
  trap cleanup_all EXIT
  run_preflight_checks
  prepare_embedded_web
  local targets=("$@")
  if [ "${#targets[@]}" -eq 0 ]; then
    targets=("${DEFAULT_TARGETS[@]}")
  fi
  for target in "${targets[@]}"; do
    package_target "$target"
  done
  write_checksums
  verify_release_artifacts "${targets[@]}"
  log "release summary: preflight passed, packages built, checksums written"
  echo "[release] assets written to $OUT_DIR"
}

main "$@"
