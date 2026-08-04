#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$ROOT_DIR/skills/xuanwu"
TARGET="${1:-}"

usage() {
  cat <<'EOF'
Usage: ./scripts/install-agent-skill.sh <codex|claude|all>

Install the Xuanwu issue-management skill for Codex, Claude Code, or both.
EOF
}

if [[ ! -f "$SOURCE_DIR/SKILL.md" ]]; then
  echo "missing skill source: $SOURCE_DIR/SKILL.md" >&2
  exit 1
fi

install_skill() {
  local agent="$1"
  local skills_dir="$2"
  local target_dir="$skills_dir/xuanwu"

  mkdir -p "$target_dir"
  cp -R "$SOURCE_DIR/." "$target_dir/"
  echo "Installed Xuanwu skill for $agent to $target_dir"
}

case "$TARGET" in
  codex)
    install_skill "Codex" "${XUANWU_CODEX_SKILLS_DIR:-${CODEX_HOME:-$HOME/.codex}/skills}"
    ;;
  claude)
    install_skill "Claude Code" "${XUANWU_CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
    ;;
  all)
    install_skill "Codex" "${XUANWU_CODEX_SKILLS_DIR:-${CODEX_HOME:-$HOME/.codex}/skills}"
    install_skill "Claude Code" "${XUANWU_CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
