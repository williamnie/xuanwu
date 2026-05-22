#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${CODEX_RUNNER_RELEASE_DIR:-$ROOT_DIR/dist/release}"
WORK_DIR="$OUT_DIR/.work"
EMBED_WEB_DIR="$ROOT_DIR/backend/internal/web/dist"
LDFLAGS="${CODEX_RUNNER_LDFLAGS:--s -w}"
DEFAULT_TARGETS=(darwin/arm64 darwin/amd64 linux/arm64 linux/amd64)

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[release] missing required command: $1" >&2
    exit 1
  fi
}

frontend_install() {
  if [ -d "$ROOT_DIR/frontend/node_modules" ]; then
    return
  fi
  if [ -f "$ROOT_DIR/frontend/package-lock.json" ]; then
    npm --prefix "$ROOT_DIR/frontend" ci
    return
  fi
  npm --prefix "$ROOT_DIR/frontend" install
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

build_frontend() {
  frontend_install
  npm --prefix "$ROOT_DIR/frontend" run build
  prepare_embedded_web
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
  build_frontend
  local targets=("$@")
  if [ "${#targets[@]}" -eq 0 ]; then
    targets=("${DEFAULT_TARGETS[@]}")
  fi
  for target in "${targets[@]}"; do
    package_target "$target"
  done
  write_checksums
  echo "[release] assets written to $OUT_DIR"
}

main "$@"
