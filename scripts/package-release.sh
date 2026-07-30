#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${CODEX_RUNNER_RELEASE_DIR:-$ROOT_DIR/dist/release}"
WORK_DIR="$OUT_DIR/.work"
DEFAULT_TARGETS=(bun-darwin-arm64 bun-darwin-x64 bun-linux-arm64 bun-linux-x64)
APP_VERSION=""
BUILD_STAMP=""
REVISION=""

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[release] missing required command: $1" >&2
    exit 1
  fi
}

log() { printf '[release] %s\n' "$*"; }
fail() { printf '[release] ERROR: %s\n' "$*" >&2; exit 1; }

resolve_app_version() {
  "$ROOT_DIR/scripts/resolve-version.sh"
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

copy_if_exists() {
  local source="$1" target="$2"
  [ -e "$source" ] || return 0
  rm -rf "$target"
  cp -R "$source" "$target"
}

stage_pi_package_assets() {
  local pkg_dir="$1" source="$ROOT_DIR/backend-ts/node_modules/@earendil-works/pi-coding-agent"
  [ -f "$source/package.json" ] || fail "missing PI package assets: $source/package.json"
  # pi-coding-agent resolves Bun binary assets relative to process.execPath.
  # Keep its package metadata and runtime assets next to our compiled binary;
  # a nested pi-coding-agent/ directory is invisible to that resolver.
  cp "$source/package.json" "$pkg_dir/package.json"
  copy_if_exists "$source/dist/modes/interactive/theme" "$pkg_dir/theme"
  copy_if_exists "$source/dist/modes/interactive/assets" "$pkg_dir/assets"
  copy_if_exists "$source/dist/core/export-html" "$pkg_dir/export-html"
  copy_if_exists "$source/examples" "$pkg_dir/examples"
  copy_if_exists "$source/docs" "$pkg_dir/docs/pi-coding-agent"
  copy_if_exists "$ROOT_DIR/backend-ts/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm" "$pkg_dir/photon_rs_bg.wasm"
}

stage_claude_sdk_executable() {
  local target="$1" pkg_dir="$2" suffix package_name version source cache archive_name
  case "$target" in
    bun-darwin-arm64) suffix="darwin-arm64" ;;
    bun-darwin-x64) suffix="darwin-x64" ;;
    bun-linux-arm64) suffix="linux-arm64" ;;
    bun-linux-x64) suffix="linux-x64" ;;
    *) fail "unsupported Claude SDK target: $target" ;;
  esac
  package_name="@anthropic-ai/claude-agent-sdk-$suffix"
  version="$(node -p "require('$ROOT_DIR/backend-ts/node_modules/@anthropic-ai/claude-agent-sdk/package.json').version")"
  source="$ROOT_DIR/backend-ts/node_modules/$package_name/claude"
  if [ ! -f "$source" ]; then
    cache="$WORK_DIR/claude-agent-sdk-$suffix"
    rm -rf "$cache"
    mkdir -p "$cache"
    log "fetching $package_name@$version for $target"
    archive_name="$(npm pack --silent --pack-destination "$cache" "$package_name@$version" | tail -n 1)"
    [ -n "$archive_name" ] && [ -f "$cache/$archive_name" ] \
      || fail "could not fetch $package_name@$version"
    LC_ALL=C tar -xzf "$cache/$archive_name" -C "$cache"
    source="$cache/package/claude"
  fi
  [ -f "$source" ] || fail "missing Claude Agent SDK native executable for $target"
  install -m 0755 "$source" "$pkg_dir/codex-issue-runner.claude-agent-sdk"
}

host_bun_target() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) printf 'bun-darwin-arm64' ;;
    Darwin-x86_64) printf 'bun-darwin-x64' ;;
    Linux-aarch64|Linux-arm64) printf 'bun-linux-arm64' ;;
    Linux-x86_64) printf 'bun-linux-x64' ;;
    *) printf '' ;;
  esac
}

smoke_host_binary() {
  local target="$1" host_target asset binary
  host_target="$(host_bun_target)"
  [ -n "$host_target" ] && [ "$target" = "$host_target" ] || return 0
  case "$target" in
    bun-darwin-arm64) asset="codex-issue-runner_darwin_arm64" ;;
    bun-darwin-x64) asset="codex-issue-runner_darwin_amd64" ;;
    bun-linux-arm64) asset="codex-issue-runner_linux_arm64" ;;
    bun-linux-x64) asset="codex-issue-runner_linux_amd64" ;;
  esac
  binary="$WORK_DIR/$asset/codex-issue-runner"
  run_step "packaged host binary smoke" "$binary" --version
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
  run_step "backend-ts tests" bash -lc "cd '$ROOT_DIR/backend-ts' && bun test --timeout 60000"
  run_step "frontend lint" npm --prefix "$ROOT_DIR/frontend" run lint
  APP_VERSION="$(resolve_app_version)"
  BUILD_STAMP="$(resolve_build_stamp)"
  REVISION="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || printf nogit)"
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
  cp "$ROOT_DIR/CHANGELOG.md" "$pkg_dir/CHANGELOG.md"
  cp "$ROOT_DIR/scripts/install-release.sh" "$pkg_dir/install-release.sh"
  cp "$ROOT_DIR/scripts/update-release.sh" "$pkg_dir/update-release.sh"
  cp "$ROOT_DIR/scripts/daemon.sh" "$pkg_dir/daemon.sh"
  mkdir -p "$pkg_dir/docs"
  cp -R "$ROOT_DIR/docs/runbooks" "$pkg_dir/docs/runbooks"
  cp "$ROOT_DIR/docs/backup-restore.md" "$pkg_dir/docs/backup-restore.md"
  cp "$ROOT_DIR/docs/architecture/xuanwu/0070-db-migration-rehearsal-gate.md" "$pkg_dir/docs/migration-rehearsal.md"
  stage_pi_package_assets "$pkg_dir"
  stage_claude_sdk_executable "$target" "$pkg_dir"
  (cd "$pkg_dir" && LC_ALL=C tar -czf "$OUT_DIR/$asset.tar.gz" .)
}

write_checksums() {
  (
    cd "$OUT_DIR"
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum *.tar.gz release.json > checksums.txt
    else
      shasum -a 256 *.tar.gz release.json > checksums.txt
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
    smoke_host_binary "$target"
  done
  local manifest_args=(
    "$ROOT_DIR/scripts/write-release-manifest.mjs"
    --version "$APP_VERSION"
    --revision "$REVISION"
    --build-stamp "$BUILD_STAMP"
    --output "$OUT_DIR/release.json"
  )
  if [ "${CODEX_RUNNER_ENFORCE_RELEASE:-0}" = "1" ]; then
    manifest_args+=(--require-changelog)
  fi
  for target in "${targets[@]}"; do manifest_args+=(--target "$target"); done
  run_step "release manifest" node "${manifest_args[@]}"
  write_checksums
  [ -s "$OUT_DIR/checksums.txt" ] || fail "missing checksum file"
  log "release assets written to $OUT_DIR"
}

main "$@"
