#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${CODEX_RUNNER_BUN_LOG_DIR:-$ROOT_DIR/data-bun/logs}"
DRY_RUN=0

for arg in "$@"; do
  [ "$arg" = "--dry-run" ] && DRY_RUN=1
done

log() {
  printf '[bun-preview-deploy] %s\n' "$*"
}

redact_log_tail() {
  local file="$1"
  [ -f "$file" ] || return 0
  tail -n 40 "$file" | sed -E \
    -e 's/(Authorization:[[:space:]]*Bearer[[:space:]]+)[^[:space:]]+/\1<redacted>/Ig' \
    -e 's/([A-Za-z_]*(TOKEN|SECRET|PASSWORD|API[_-]?KEY)[A-Za-z_]*=)[^[:space:]]+/\1<redacted>/Ig' \
    -e 's/("(token|secret|password|api[_-]?key|authorization)"[[:space:]]*:[[:space:]]*")[^"]+/\1<redacted>/Ig'
}

print_failure_diagnostics() {
  local log_file
  log "failure diagnostics:"
  "$ROOT_DIR/scripts/status-bun-preview.sh" || true
  for log_file in "$LOG_DIR/launchd.err.log" "$LOG_DIR/launchd.out.log"; do
    if [ -f "$log_file" ]; then
      log "recent $(basename "$log_file"):"
      redact_log_tail "$log_file"
    fi
  done
}

main() {
  log "building binary and restarting Bun preview launchd..."
  "$ROOT_DIR/scripts/install-bun-launchd.sh" "$@" || return $?
  if [ "$DRY_RUN" -eq 1 ]; then
    log "dry-run complete; verification skipped"
    return 0
  fi
  log "verifying Bun preview health/status..."
  "$ROOT_DIR/scripts/status-bun-preview.sh" || return $?
  log "done"
}

main "$@" || {
  status=$?
  print_failure_diagnostics
  exit "$status"
}
