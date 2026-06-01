#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${CODEX_RUNNER_RELEASE_DIR:-$ROOT_DIR/dist/release}"
WORK_DIR="$OUT_DIR/.work"
DEFAULT_TARGETS=(bun-darwin-arm64 bun-darwin-x64 bun-linux-arm64 bun-linux-x64)
APP_VERSION=""
BUILD_STAMP=""

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[release] missing required command: $1" >&2
    exit 1
  fi
}

log() { printf '[release] %s\n' "$*"; }
fail() { printf '[release] ERROR: %s\n' "$*" >&2; exit 1; }

resolve_app_version() {
  if [ -n "${CODEX_RUNNER_VERSION:-}" ]; then
    printf '%s' "$CODEX_RUNNER_VERSION"
  elif [ -n "${GITHUB_REF_NAME:-}" ]; then
    printf '%s' "$GITHUB_REF_NAME"
  else
    printf '0.0.0-dev'
  fi
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

run_step() {
  local label="$1"
  shift
  log "preflight: $label"
  if ! "$@"; then
    fail "$label failed"
  fi
}

install_deps() {
  if [ ! -d "$ROOT_DIR/backend-ts/node_modules" ]; then
    run_step "backend bun install" bun install --cwd "$ROOT_DIR/backend-ts"
  fi
  if [ ! -d "$ROOT_DIR/frontend/node_modules" ]; then
    if [ -f "$ROOT_DIR/frontend/package-lock.json" ]; then
      run_step "frontend npm ci" npm --prefix "$ROOT_DIR/frontend" ci
    else
      run_step "frontend npm install" npm --prefix "$ROOT_DIR/frontend" install
    fi
  fi
}

run_preflight_checks() {
  install_deps
  run_step "backend-ts tests" bash -lc "cd '$ROOT_DIR/backend-ts' && bun test"
  run_step "frontend lint" npm --prefix "$ROOT_DIR/frontend" run lint
  APP_VERSION="$(resolve_app_version)"
  BUILD_STAMP="$(resolve_build_stamp)"
  log "frontend version: $APP_VERSION"
  log "build stamp: $BUILD_STAMP"
  run_step "frontend build" env VITE_APP_VERSION="$APP_VERSION" npm --prefix "$ROOT_DIR/frontend" run build
}

package_target() {
  local target="$1" arch asset pkg_dir outfile
  case "$target" in
    bun-darwin-arm64) arch="darwin_arm64" ;;
    bun-darwin-x64) arch="darwin_amd64" ;;
    bun-linux-arm64) arch="linux_arm64" ;;
    bun-linux-x64) arch="linux_amd64" ;;
    *) fail "unsupported Bun target: $target" ;;
  esac
  asset="codex-issue-runner_${arch}"
  pkg_dir="$WORK_DIR/$asset"
  outfile="$pkg_dir/codex-issue-runner"
  rm -rf "$pkg_dir"
  mkdir -p "$pkg_dir"
  log "building $target"
  (
    cd "$ROOT_DIR/backend-ts"
    CODEX_RUNNER_BUILD_VERSION="$APP_VERSION" \
    CODEX_RUNNER_BUILD_STAMP="$BUILD_STAMP" \
      bun build ./src/main.ts --compile --target="$target" '--env=CODEX_RUNNER_BUILD_*' --outfile "$outfile"
  )
  printf '%s\n' "$BUILD_STAMP" > "$pkg_dir/codex-issue-runner.build.stamp"
  cp -R "$ROOT_DIR/frontend/dist" "$pkg_dir/web"
  cp "$ROOT_DIR/README.md" "$pkg_dir/README.md"
  cp "$ROOT_DIR/scripts/install-release.sh" "$pkg_dir/install-release.sh"
  (cd "$pkg_dir" && LC_ALL=C tar -czf "$OUT_DIR/$asset.tar.gz" .)
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
  require_cmd bun
  require_cmd npm
  require_cmd tar
  rm -rf "$OUT_DIR"
  mkdir -p "$OUT_DIR" "$WORK_DIR"
  trap 'rm -rf "$WORK_DIR"' EXIT
  run_preflight_checks
  local targets=("$@")
  if [ "${#targets[@]}" -eq 0 ]; then
    targets=("${DEFAULT_TARGETS[@]}")
  fi
  for target in "${targets[@]}"; do
    package_target "$target"
  done
  write_checksums
  [ -s "$OUT_DIR/checksums.txt" ] || fail "missing checksum file"
  log "release assets written to $OUT_DIR"
}

main "$@"
