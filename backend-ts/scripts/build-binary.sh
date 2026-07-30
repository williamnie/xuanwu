#!/usr/bin/env bash
set -euo pipefail

BACKEND_TS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$BACKEND_TS_DIR/.." && pwd)"
OUTFILE="${CODEX_RUNNER_BINARY:-$ROOT_DIR/dist/codex-issue-runner}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[bun-build] missing required command: $1" >&2
    exit 1
  fi
}

is_darwin() {
  [ "$(uname -s)" = "Darwin" ]
}

resolve_codesign_identity() {
  local configured="${CODEX_RUNNER_CODESIGN_IDENTITY:-auto}"
  if [ "$configured" = "none" ] || [ "$configured" = "skip" ] || [ "$configured" = "0" ]; then
    return 0
  fi
  if [ "$configured" != "auto" ] && [ -n "$configured" ]; then
    printf '%s' "$configured"
    return 0
  fi
  is_darwin || return 0
  command -v security >/dev/null 2>&1 || return 0
  security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/.*"\(Apple Development:[^"]*\)".*/\1/p' \
    | head -n 1
}

sign_binary_if_possible() {
  local identity identifier
  identity="$(resolve_codesign_identity)"
  if [ -z "$identity" ]; then
    echo "[bun-build] codesign: skipped (set CODEX_RUNNER_CODESIGN_IDENTITY to sign this binary)"
    return
  fi
  identifier="${CODEX_RUNNER_CODESIGN_IDENTIFIER:-com.xiaobei.codex-issue-runner}"
  echo "[bun-build] codesign identity: $identity"
  echo "[bun-build] codesign identifier: $identifier"
  codesign --force --sign "$identity" --identifier "$identifier" --timestamp=none "$OUTFILE"
  codesign -dv --verbose=2 "$OUTFILE" 2>&1 \
    | awk '/^(Identifier|TeamIdentifier|Authority|Signature)=/ { print "[bun-build] " $0 }'
}

resolve_version() {
  "$ROOT_DIR/scripts/resolve-version.sh"
}

normalize_output_path() {
  local path="$1"
  local dir base
  dir="$(dirname "$path")"
  base="$(basename "$path")"
  mkdir -p "$dir"
  printf '%s/%s' "$(cd "$dir" && pwd -P)" "$base"
}

stage_claude_sdk_executable() {
  local package_suffix source target_dir staged target
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) package_suffix="darwin-arm64" ;;
    Darwin-x86_64) package_suffix="darwin-x64" ;;
    Linux-aarch64|Linux-arm64) package_suffix="linux-arm64" ;;
    Linux-x86_64) package_suffix="linux-x64" ;;
    *) echo "[bun-build] unsupported Claude SDK native target: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
  esac
  source="$BACKEND_TS_DIR/node_modules/@anthropic-ai/claude-agent-sdk-$package_suffix/claude"
  [ -f "$source" ] || {
    echo "[bun-build] missing Claude Agent SDK native executable: $source" >&2
    exit 1
  }
  target="$OUTFILE.claude-agent-sdk"
  target_dir="$(dirname "$target")"
  staged="$(mktemp "$target_dir/.claude-agent-sdk-stage.XXXXXX")"
  cp -p "$source" "$staged"
  chmod 0755 "$staged"
  mv -f "$staged" "$target"
  echo "[bun-build] claude sdk executable: $target"
}

resolve_build_stamp() {
  local revision dirty
  revision="nogit"
  dirty="clean"
  if command -v git >/dev/null 2>&1 && git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    revision="$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD 2>/dev/null || printf 'nogit')"
    if [ -n "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=normal -- . ':!dist')" ]; then
      dirty="dirty"
    fi
  fi
  printf '%s-%s-%s' "$(date -u '+%Y%m%dT%H%M%SZ')" "$revision" "$dirty"
}

require_cmd bun
OUTFILE="$(normalize_output_path "$OUTFILE")"
APP_VERSION="$(resolve_version)"
BUILD_STAMP="$(resolve_build_stamp)"

echo "[bun-build] version: $APP_VERSION"
echo "[bun-build] build_stamp: $BUILD_STAMP"
echo "[bun-build] outfile: $OUTFILE"

(
  cd "$BACKEND_TS_DIR"
  CODEX_RUNNER_BUILD_VERSION="$APP_VERSION" \
  CODEX_RUNNER_BUILD_STAMP="$BUILD_STAMP" \
    bun build ./src/main.ts --compile '--env=CODEX_RUNNER_BUILD_*' --outfile "$OUTFILE"
)

stage_claude_sdk_executable
sign_binary_if_possible
printf '%s\n' "$BUILD_STAMP" > "$OUTFILE.build.stamp"
echo "[bun-build] binary: $OUTFILE"
echo "[bun-build] stamp: $OUTFILE.build.stamp"
echo "[bun-build] summary: version=$APP_VERSION build_stamp=$BUILD_STAMP artifact=$(basename "$OUTFILE")"
