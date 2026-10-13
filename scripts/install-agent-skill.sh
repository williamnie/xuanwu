#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"

usage() {
  cat <<'EOF'
Usage: ./scripts/install-agent-skill.sh <codex|claude|agents|all>

Install Xuanwu agent skills (xuanwu issue runner and xuanwu-ui design system)
for Codex, Claude Code, ~/.agents/skills, or all of them.
EOF
}

install_all_skills() {
  local agent="$1"
  local skills_dir="$2"

  for skill in xuanwu xuanwu-ui; do
    local src="$ROOT_DIR/skills/$skill"
    if [[ -d "$src" && -f "$src/SKILL.md" ]]; then
      local target_dir="$skills_dir/$skill"
      mkdir -p "$target_dir"
      cp -R "$src/." "$target_dir/"
      if [[ "$skill" == "xuanwu" ]]; then
        echo "Installed Xuanwu skill for $agent to $target_dir"
      else
        echo "Installed Xuanwu UI skill for $agent to $target_dir"
      fi
    fi
  done
}

case "$TARGET" in
  codex)
    install_all_skills "Codex" "${XUANWU_CODEX_SKILLS_DIR:-${CODEX_HOME:-$HOME/.codex}/skills}"
    ;;
  claude)
    install_all_skills "Claude Code" "${XUANWU_CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
    ;;
  agents)
    install_all_skills "Agents" "${XUANWU_AGENTS_SKILLS_DIR:-$HOME/.agents/skills}"
    ;;
  all)
    install_all_skills "Codex" "${XUANWU_CODEX_SKILLS_DIR:-${CODEX_HOME:-$HOME/.codex}/skills}"
    install_all_skills "Claude Code" "${XUANWU_CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
    install_all_skills "Agents" "${XUANWU_AGENTS_SKILLS_DIR:-$HOME/.agents/skills}"
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
