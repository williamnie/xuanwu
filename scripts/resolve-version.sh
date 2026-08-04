#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${XUANWU_ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
FALLBACK_VERSION="${XUANWU_FALLBACK_VERSION:-unknown}"

clean() {
  local value="${1:-}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  [ -n "$value" ] && printf '%s' "$value"
}

from_env() {
  clean "${XUANWU_VERSION:-}" && return 0
  clean "${VITE_APP_VERSION:-}" && return 0
  if [ "${GITHUB_REF_TYPE:-}" = "tag" ]; then
    clean "${GITHUB_REF_NAME:-}" && return 0
  fi
  return 1
}

from_git() {
  command -v git >/dev/null 2>&1 || return 1
  git -C "$ROOT_DIR" describe --tags --dirty --always 2>/dev/null \
    | sed -n '1{s/[[:space:]]*$//;p;q;}'
}

main() {
  from_env || from_git || printf '%s' "$FALLBACK_VERSION"
}

main "$@"
