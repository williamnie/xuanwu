#!/usr/bin/env bash
set -euo pipefail

if [ "${CODEX_RUNNER_MANAGED_EXECUTION:-}" = "1" ] ||
  { [ -n "${PI_PACKAGE_DIR:-}" ] && [ -n "${CODEX_RUNNER_CODEX_SERVER_MODE:-}" ]; }; then
  echo "[deploy-guard] denied: live deployment cannot run from a Runner-managed provider process." >&2
  exit 78
fi

REPO="${CODEX_RUNNER_REPO:-williamnie/xuanwu}"
INSTALL_DIR="${CODEX_RUNNER_INSTALL_DIR:-$HOME/.local/bin}"
STATE_DIR="${CODEX_RUNNER_STATE_DIR:-$HOME/.local/state/codex-issue-runner}"
LOG_DIR="${CODEX_RUNNER_LOG_DIR:-$STATE_DIR/logs}"
ADDR="${CODEX_RUNNER_ADDR:-0.0.0.0:3008}"
LABEL="${CODEX_RUNNER_LAUNCHD_LABEL:-com.xiaobei.codex-issue-runner}"
SERVICE_NAME="${CODEX_RUNNER_SERVICE_NAME:-codex-issue-runner}"
BIN_PATH="${CODEX_RUNNER_BINARY:-$INSTALL_DIR/codex-issue-runner}"
CLAUDE_SDK_EXECUTABLE_PATH="$BIN_PATH.claude-agent-sdk"
DAEMON_PATH="$INSTALL_DIR/codex-issue-runner-daemon"
INSTALLER_PATH="${CODEX_RUNNER_INSTALLER:-$INSTALL_DIR/codex-issue-runner-install}"
UPDATER_PATH="$INSTALL_DIR/codex-issue-runner-update"
RELEASES_DIR="$STATE_DIR/releases"
AUDIT_LOG="$LOG_DIR/release-upgrade.log"
RELEASE_RETENTION="${CODEX_RUNNER_RELEASE_RETENTION:-3}"

usage() {
  cat <<'HELP'
Usage:
  codex-issue-runner-update check [--json]
  codex-issue-runner-update upgrade --apply --actor <id> --actor-kind user|system \
    --audit-ref <ref> --reason <text> --backup-ref <ref> --confirm-backup-tested
  codex-issue-runner-update rollback --snapshot <path|latest> --apply --actor <id> \
    --actor-kind user|system --audit-ref <ref> --reason <text> --backup-ref <ref> \
    --confirm-data-compatible

`check` is read-only. Upgrade and rollback are deterministic, audited mutations.
Rollback restores release-owned files only; it never rewrites runner.db or secrets.
HELP
}

log() { printf '[update] %s\n' "$*"; }
fail() { printf '[update] ERROR: %s\n' "$*" >&2; exit 1; }

service_url() {
  if [[ "$ADDR" == 0.0.0.0:* ]]; then
    printf 'http://127.0.0.1:%s' "${ADDR##*:}"
  elif [[ "$ADDR" == :* ]]; then
    printf 'http://127.0.0.1%s' "$ADDR"
  else
    printf 'http://%s' "$ADDR"
  fi
}

current_version() {
  [ -x "$BIN_PATH" ] || { printf 'not-installed'; return; }
  "$BIN_PATH" --version 2>/dev/null | awk 'NR == 1 { print $2; exit }'
}

latest_metadata() {
  local destination="$1"
  curl -fsSL --retry 3 -o "$destination" \
    "https://github.com/$REPO/releases/latest/download/release.json"
}

metadata_version() {
  local value
  value="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -n 1)"
  printf '%s' "$value" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$' \
    || fail "release.json contains an invalid version"
  printf '%s' "$value"
}

is_newer_version() {
  local current="$1" latest="$2"
  awk -v current="$current" -v latest="$latest" '
    function parse(value, out,    clean, count, pieces, core, i) {
      clean = substr(value, 2)
      count = split(clean, pieces, /[-+]/)
      core = pieces[1]
      split(core, out, ".")
      out[4] = (index(clean, "-") ? substr(clean, index(clean, "-") + 1) : "")
    }
    BEGIN {
      if (current !~ /^v[0-9]+\.[0-9]+\.[0-9]+/ || latest !~ /^v[0-9]+\.[0-9]+\.[0-9]+/) exit 1
      parse(current, a); parse(latest, b)
      for (i = 1; i <= 3; i++) {
        if ((b[i] + 0) > (a[i] + 0)) exit 0
        if ((b[i] + 0) < (a[i] + 0)) exit 1
      }
      if (a[4] != "" && b[4] == "") exit 0
      if (a[4] == "" && b[4] != "") exit 1
      exit !(b[4] > a[4])
    }
  '
}

check_update() {
  local json="$1" temp current latest available
  temp="$(mktemp)"
  latest_metadata "$temp"
  latest="$(metadata_version "$temp")"
  current="$(current_version)"
  available=false
  if is_newer_version "$current" "$latest"; then available=true; fi
  if [ "$json" = true ]; then
    printf '{"current":"%s","latest":"%s","update_available":%s}\n' "$current" "$latest" "$available"
  else
    printf 'current=%s\nlatest=%s\nupdate_available=%s\n' "$current" "$latest" "$available"
  fi
}

audit() {
  local action="$1" outcome="$2" from="$3" to="$4" snapshot="$5"
  mkdir -p "$LOG_DIR"
  chmod 700 "$LOG_DIR" 2>/dev/null || true
  printf '%s action=%s outcome=%s from=%s to=%s actor=%q actor_kind=%q audit_ref=%q backup_ref=%q snapshot=%q reason=%q\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$action" "$outcome" "$from" "$to" \
    "$ACTOR" "$ACTOR_KIND" "$AUDIT_REF" "$BACKUP_REF" "$snapshot" "$REASON" >> "$AUDIT_LOG"
  chmod 600 "$AUDIT_LOG" 2>/dev/null || true
}

require_mutation_gate() {
  [ "$APPLY" = true ] || fail "mutation requires --apply"
  [ -n "$ACTOR" ] || fail "mutation requires --actor"
  case "$ACTOR_KIND" in user|system) ;; *) fail "--actor-kind must be user or system; llm is forbidden" ;; esac
  [ -n "$AUDIT_REF" ] || fail "mutation requires --audit-ref"
  [ -n "$REASON" ] || fail "mutation requires --reason"
  [ -n "$BACKUP_REF" ] || fail "mutation requires --backup-ref"
  case "$RELEASE_RETENTION" in ''|0|*[!0-9]*) fail "CODEX_RUNNER_RELEASE_RETENTION must be a positive integer" ;; esac
}

copy_file_if_present() {
  local source="$1" destination="$2"
  [ -f "$source" ] || return 0
  cp -p "$source" "$destination"
}

copy_dir_if_present() {
  local source="$1" destination="$2"
  [ -d "$source" ] || return 0
  cp -R "$source" "$destination"
}

snapshot_release() {
  local version="$1" stamp snapshot
  stamp="$(date -u '+%Y%m%dT%H%M%SZ')-$$"
  snapshot="$RELEASES_DIR/${version//\//_}-$stamp"
  mkdir -p "$snapshot/bin" "$snapshot/state" "$snapshot/service"
  copy_file_if_present "$BIN_PATH" "$snapshot/bin/codex-issue-runner"
  copy_file_if_present "$CLAUDE_SDK_EXECUTABLE_PATH" "$snapshot/bin/codex-issue-runner.claude-agent-sdk"
  copy_file_if_present "$DAEMON_PATH" "$snapshot/bin/codex-issue-runner-daemon"
  copy_file_if_present "$INSTALLER_PATH" "$snapshot/bin/codex-issue-runner-install"
  copy_file_if_present "$UPDATER_PATH" "$snapshot/bin/codex-issue-runner-update"
  copy_file_if_present "$INSTALL_DIR/photon_rs_bg.wasm" "$snapshot/bin/photon_rs_bg.wasm"
  copy_dir_if_present "$STATE_DIR/web" "$snapshot/state/web"
  copy_dir_if_present "$STATE_DIR/pi-coding-agent" "$snapshot/state/pi-coding-agent"
  copy_file_if_present "$HOME/Library/LaunchAgents/$LABEL.plist" "$snapshot/service/$LABEL.plist"
  copy_file_if_present "$HOME/Library/LaunchAgents/$LABEL.web.plist" "$snapshot/service/$LABEL.web.plist"
  copy_file_if_present "$HOME/Library/LaunchAgents/$LABEL.core.plist" "$snapshot/service/$LABEL.core.plist"
  copy_file_if_present "$HOME/.config/systemd/user/$SERVICE_NAME.service" "$snapshot/service/$SERVICE_NAME.service"
  copy_file_if_present "$HOME/.config/systemd/user/$SERVICE_NAME-web.service" "$snapshot/service/$SERVICE_NAME-web.service"
  copy_file_if_present "$HOME/.config/systemd/user/$SERVICE_NAME-core.service" "$snapshot/service/$SERVICE_NAME-core.service"
  printf '1\n' > "$snapshot/service/version"
  printf '%s\n' "$version" > "$snapshot/version"
  printf '%s' "$snapshot"
}

restore_file() {
  local source="$1" destination="$2" mode="${3:-0755}" staged
  if [ ! -f "$source" ]; then rm -f "$destination"; return 0; fi
  staged="$destination.rollback.$$"
  install -m "$mode" "$source" "$staged"
  mv -f "$staged" "$destination"
}

restore_dir() {
  local source="$1" destination="$2" staged previous
  staged="$destination.rollback-stage.$$"
  previous="$destination.rollback-previous.$$"
  if [ -d "$source" ]; then cp -R "$source" "$staged"; fi
  if [ -e "$destination" ]; then mv "$destination" "$previous"; fi
  if [ -e "$staged" ]; then mv "$staged" "$destination"; fi
  if [ -e "$previous" ]; then rm -rf "$previous"; fi
}

restore_snapshot() {
  local snapshot="$1"
  [ -d "$snapshot" ] || fail "rollback snapshot not found: $snapshot"
  [ -x "$snapshot/bin/codex-issue-runner" ] || fail "snapshot has no runner binary: $snapshot"
  "$DAEMON_PATH" stop >/dev/null 2>&1 || true
  mkdir -p "$INSTALL_DIR" "$STATE_DIR"
  restore_file "$snapshot/bin/codex-issue-runner" "$BIN_PATH"
  restore_file "$snapshot/bin/codex-issue-runner.claude-agent-sdk" "$CLAUDE_SDK_EXECUTABLE_PATH"
  restore_file "$snapshot/bin/codex-issue-runner-daemon" "$DAEMON_PATH"
  restore_file "$snapshot/bin/codex-issue-runner-install" "$INSTALLER_PATH"
  restore_file "$snapshot/bin/codex-issue-runner-update" "$UPDATER_PATH"
  restore_file "$snapshot/bin/photon_rs_bg.wasm" "$INSTALL_DIR/photon_rs_bg.wasm" 0644
  restore_dir "$snapshot/state/web" "$STATE_DIR/web"
  restore_dir "$snapshot/state/pi-coding-agent" "$STATE_DIR/pi-coding-agent"
  restore_service_registration "$snapshot"
  "$DAEMON_PATH" start >/dev/null
  wait_ready
}

restore_service_registration() {
  local snapshot="$1" name source target
  [ -f "$snapshot/service/version" ] || return 0
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.config/systemd/user"
  for name in "$LABEL.plist" "$LABEL.web.plist" "$LABEL.core.plist"; do
    source="$snapshot/service/$name"
    target="$HOME/Library/LaunchAgents/$name"
    restore_file "$source" "$target" 0644
  done
  for name in "$SERVICE_NAME.service" "$SERVICE_NAME-web.service" "$SERVICE_NAME-core.service"; do
    source="$snapshot/service/$name"
    target="$HOME/.config/systemd/user/$name"
    restore_file "$source" "$target" 0644
  done
  if command -v systemctl >/dev/null 2>&1; then systemctl --user daemon-reload >/dev/null 2>&1 || true; fi
}

wait_ready() {
  local url
  url="$(service_url)"
  for _ in {1..120}; do
    if curl -fsS "$url/health" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  return 1
}

latest_snapshot() {
  find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null | LC_ALL=C sort | tail -n 1
}

prune_snapshots() {
  local snapshots=() path remove_count index
  while IFS= read -r path; do snapshots+=("$path"); done < <(
    find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null | LC_ALL=C sort
  )
  remove_count=$((${#snapshots[@]} - RELEASE_RETENTION))
  [ "$remove_count" -gt 0 ] || return 0
  for ((index = 0; index < remove_count; index += 1)); do
    path="${snapshots[$index]}"
    rm -rf "$path"
    audit snapshot-prune applied "-" "-" "$path"
  done
}

upgrade_release() {
  local temp from to snapshot
  require_mutation_gate
  [ "$CONFIRM_BACKUP_TESTED" = true ] || fail "upgrade requires --confirm-backup-tested"
  [ -x "$INSTALLER_PATH" ] || fail "release installer not found: $INSTALLER_PATH"
  temp="$(mktemp)"
  latest_metadata "$temp"
  to="$(metadata_version "$temp")"
  from="$(current_version)"
  if ! is_newer_version "$from" "$to"; then log "no newer release: current=$from latest=$to"; return 0; fi
  audit upgrade requested "$from" "$to" "pending"
  if ! snapshot="$(snapshot_release "$from")"; then
    audit upgrade failed "$from" "$to" "snapshot-failed"
    fail "could not create release snapshot"
  fi
  if CODEX_RUNNER_VERSION="$to" \
    CODEX_RUNNER_AUDIT_ACTOR="$ACTOR" CODEX_RUNNER_AUDIT_ACTOR_KIND="$ACTOR_KIND" \
    CODEX_RUNNER_AUDIT_REF="$AUDIT_REF" CODEX_RUNNER_AUDIT_REASON="$REASON" \
    "$INSTALLER_PATH"; then
    audit upgrade applied "$from" "$to" "$snapshot"
    prune_snapshots
    log "upgraded $from -> $to"
    log "rollback snapshot: $snapshot"
    return 0
  fi
  restore_snapshot "$snapshot" || true
  audit upgrade failed "$from" "$to" "$snapshot"
  fail "upgrade failed; previous release restoration was attempted from $snapshot"
}

rollback_release() {
  local from to target rollforward
  require_mutation_gate
  [ "$CONFIRM_DATA_COMPATIBLE" = true ] || fail "rollback requires --confirm-data-compatible"
  target="$SNAPSHOT"
  [ "$target" != latest ] || target="$(latest_snapshot)"
  [ -n "$target" ] && [ -d "$target" ] || fail "no rollback snapshot available"
  from="$(current_version)"
  to="$(cat "$target/version" 2>/dev/null || printf unknown)"
  audit rollback requested "$from" "$to" "$target"
  if ! rollforward="$(snapshot_release "$from")"; then
    audit rollback failed "$from" "$to" "snapshot-failed"
    fail "could not create roll-forward snapshot"
  fi
  if restore_snapshot "$target"; then
    audit rollback applied "$from" "$to" "$target"
    prune_snapshots
    log "rolled back $from -> $to"
    log "roll-forward snapshot: $rollforward"
    return 0
  fi
  restore_snapshot "$rollforward" || true
  audit rollback failed "$from" "$to" "$target"
  fail "rollback failed; roll-forward restoration was attempted from $rollforward"
}

COMMAND="${1:-}"
[ -n "$COMMAND" ] || { usage; exit 64; }
shift || true
APPLY=false
JSON=false
ACTOR=""
ACTOR_KIND=""
AUDIT_REF=""
REASON=""
BACKUP_REF=""
SNAPSHOT=latest
CONFIRM_BACKUP_TESTED=false
CONFIRM_DATA_COMPATIBLE=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) APPLY=true ;;
    --json) JSON=true ;;
    --actor) shift; ACTOR="${1:-}" ;;
    --actor-kind) shift; ACTOR_KIND="${1:-}" ;;
    --audit-ref) shift; AUDIT_REF="${1:-}" ;;
    --reason) shift; REASON="${1:-}" ;;
    --backup-ref) shift; BACKUP_REF="${1:-}" ;;
    --snapshot) shift; SNAPSHOT="${1:-}" ;;
    --confirm-backup-tested) CONFIRM_BACKUP_TESTED=true ;;
    --confirm-data-compatible) CONFIRM_DATA_COMPATIBLE=true ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
  shift
done

case "$COMMAND" in
  check) check_update "$JSON" ;;
  upgrade) upgrade_release ;;
  rollback) rollback_release ;;
  help|-h|--help) usage ;;
  *) usage >&2; exit 64 ;;
esac
