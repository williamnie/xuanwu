#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$ROOT_DIR/skills/codex-issue-runner"
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
TARGET_DIR="$CODEX_HOME_DIR/skills/codex-issue-runner"

if [[ ! -f "$SOURCE_DIR/SKILL.md" ]]; then
  echo "missing skill source: $SOURCE_DIR/SKILL.md" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
cp "$SOURCE_DIR/SKILL.md" "$TARGET_DIR/SKILL.md"

echo "Installed codex-issue-runner skill to $TARGET_DIR"
