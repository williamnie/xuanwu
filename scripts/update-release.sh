#!/usr/bin/env bash
set -euo pipefail

if { [ "${XUANWU_MANAGED_EXECUTION:-}" = "1" ] ||
  { [ -n "${PI_PACKAGE_DIR:-}" ] && [ -n "${XUANWU_CODEX_SERVER_MODE:-}" ]; }; } &&
  [ "${1:-}" != "check" ] && [ "${1:-}" != "help" ] &&
  [ "${1:-}" != "-h" ] && [ "${1:-}" != "--help" ]; then
  echo "[deploy-guard] denied: live deployment cannot run from a Runner-managed provider process." >&2
  exit 78
fi

REPO="${XUANWU_REPO:-williamnie/xuanwu}"
INSTALL_DIR="${XUANWU_INSTALL_DIR:-$HOME/.local/bin}"
STATE_DIR="${XUANWU_STATE_DIR:-$HOME/.local/state/xuanwu}"
LOG_DIR="${XUANWU_LOG_DIR:-$STATE_DIR/logs}"
BACKUP_DIR="${XUANWU_BACKUP_DIR:-$STATE_DIR-backups}"
ADDR="${XUANWU_ADDR:-0.0.0.0:3008}"
LABEL="${XUANWU_LAUNCHD_LABEL:-com.xiaobei.xuanwu}"
SERVICE_NAME="${XUANWU_SERVICE_NAME:-xuanwu}"
BIN_PATH="${XUANWU_BINARY:-$INSTALL_DIR/xuanwu}"
DB_PATH="${XUANWU_DB:-$STATE_DIR/runner.db}"
CLAUDE_SDK_EXECUTABLE_PATH="$BIN_PATH.claude-agent-sdk"
QODERCLI_RUNTIME_PATH="$BIN_PATH.qodercli"
QODERCLI_EXECUTABLE_PATH="$QODERCLI_RUNTIME_PATH/qodercli.mjs"
LEGACY_QODERCLI_EXECUTABLE_PATH="$BIN_PATH.qodercli.mjs"
PI_POLICY_EXTENSION_PATH="$BIN_PATH.pi-policy-extension.ts"
DAEMON_PATH="$INSTALL_DIR/xuanwu-daemon"
INSTALLER_PATH="${XUANWU_INSTALLER:-$INSTALL_DIR/xuanwu-install}"
UPDATER_PATH="$INSTALL_DIR/xuanwu-update"
RELEASES_DIR="$STATE_DIR/releases"
AUDIT_LOG="$LOG_DIR/release-upgrade.log"
RELEASE_RETENTION="${XUANWU_RELEASE_RETENTION:-3}"
JOBS_DIR="$STATE_DIR/release-update-jobs"
TARGET_VERSION=""

usage() {
  cat <<'HELP'
Usage:
  xuanwu-update check [--json]
  xuanwu-update apply-pending
  xuanwu-update upgrade --apply --actor <id> --actor-kind user|system \
    --audit-ref <ref> --reason <text> --backup-ref <ref> --confirm-backup-tested
  xuanwu-update rollback --snapshot <path|latest> --apply --actor <id> \
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

version_metadata() {
  local version="$1" destination="$2"
  printf '%s' "$version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$' \
    || fail "requested release version is invalid"
  curl -fsSL --retry 3 -o "$destination" \
    "https://github.com/$REPO/releases/download/$version/release.json"
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
  case "$RELEASE_RETENTION" in ''|0|*[!0-9]*) fail "XUANWU_RELEASE_RETENTION must be a positive integer" ;; esac
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
  copy_file_if_present "$BIN_PATH" "$snapshot/bin/xuanwu"
  copy_file_if_present "$CLAUDE_SDK_EXECUTABLE_PATH" "$snapshot/bin/xuanwu.claude-agent-sdk"
  copy_dir_if_present "$QODERCLI_RUNTIME_PATH" "$snapshot/bin/xuanwu.qodercli"
  copy_file_if_present "$LEGACY_QODERCLI_EXECUTABLE_PATH" "$snapshot/bin/xuanwu.qodercli.mjs"
  copy_file_if_present "$PI_POLICY_EXTENSION_PATH" "$snapshot/bin/xuanwu.pi-policy-extension.ts"
  copy_file_if_present "$DAEMON_PATH" "$snapshot/bin/xuanwu-daemon"
  copy_file_if_present "$INSTALLER_PATH" "$snapshot/bin/xuanwu-install"
  copy_file_if_present "$UPDATER_PATH" "$snapshot/bin/xuanwu-update"
  copy_file_if_present "$INSTALL_DIR/photon_rs_bg.wasm" "$snapshot/bin/photon_rs_bg.wasm"
  copy_dir_if_present "$STATE_DIR/web" "$snapshot/state/web"
  copy_dir_if_present "$STATE_DIR/pi-coding-agent" "$snapshot/state/pi-coding-agent"
  copy_file_if_present "$HOME/Library/LaunchAgents/$LABEL.plist" "$snapshot/service/$LABEL.plist"
  copy_file_if_present "$HOME/Library/LaunchAgents/$LABEL.web.plist" "$snapshot/service/$LABEL.web.plist"
  copy_file_if_present "$HOME/Library/LaunchAgents/$LABEL.core.plist" "$snapshot/service/$LABEL.core.plist"
  copy_file_if_present "$HOME/Library/LaunchAgents/$LABEL.agentic.plist" "$snapshot/service/$LABEL.agentic.plist"
  copy_file_if_present "$HOME/Library/LaunchAgents/$LABEL.updater.plist" "$snapshot/service/$LABEL.updater.plist"
  copy_file_if_present "$HOME/.config/systemd/user/$SERVICE_NAME.service" "$snapshot/service/$SERVICE_NAME.service"
  copy_file_if_present "$HOME/.config/systemd/user/$SERVICE_NAME-web.service" "$snapshot/service/$SERVICE_NAME-web.service"
  copy_file_if_present "$HOME/.config/systemd/user/$SERVICE_NAME-core.service" "$snapshot/service/$SERVICE_NAME-core.service"
  copy_file_if_present "$HOME/.config/systemd/user/$SERVICE_NAME-agentic.service" "$snapshot/service/$SERVICE_NAME-agentic.service"
  copy_file_if_present "$HOME/.config/systemd/user/$SERVICE_NAME-updater.service" "$snapshot/service/$SERVICE_NAME-updater.service"
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
  [ -x "$snapshot/bin/xuanwu" ] || fail "snapshot has no runner binary: $snapshot"
  "$DAEMON_PATH" stop >/dev/null 2>&1 || true
  mkdir -p "$INSTALL_DIR" "$STATE_DIR"
  restore_file "$snapshot/bin/xuanwu" "$BIN_PATH"
  restore_file "$snapshot/bin/xuanwu.claude-agent-sdk" "$CLAUDE_SDK_EXECUTABLE_PATH"
  restore_dir "$snapshot/bin/xuanwu.qodercli" "$QODERCLI_RUNTIME_PATH"
  restore_file "$snapshot/bin/xuanwu.qodercli.mjs" "$LEGACY_QODERCLI_EXECUTABLE_PATH"
  restore_file "$snapshot/bin/xuanwu.pi-policy-extension.ts" "$PI_POLICY_EXTENSION_PATH" 0644
  restore_file "$snapshot/bin/xuanwu-daemon" "$DAEMON_PATH"
  restore_file "$snapshot/bin/xuanwu-install" "$INSTALLER_PATH"
  restore_file "$snapshot/bin/xuanwu-update" "$UPDATER_PATH"
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
  for name in "$LABEL.plist" "$LABEL.web.plist" "$LABEL.core.plist" "$LABEL.agentic.plist" "$LABEL.updater.plist"; do
    source="$snapshot/service/$name"
    target="$HOME/Library/LaunchAgents/$name"
    restore_file "$source" "$target" 0644
  done
  for name in "$SERVICE_NAME.service" "$SERVICE_NAME-web.service" "$SERVICE_NAME-core.service" "$SERVICE_NAME-agentic.service" "$SERVICE_NAME-updater.service"; do
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
  if [ -n "$TARGET_VERSION" ]; then
    version_metadata "$TARGET_VERSION" "$temp"
  else
    latest_metadata "$temp"
  fi
  to="$(metadata_version "$temp")"
  if [ -n "$TARGET_VERSION" ] && [ "$to" != "$TARGET_VERSION" ]; then
    fail "requested release metadata mismatch: requested=$TARGET_VERSION metadata=$to"
  fi
  from="$(current_version)"
  if ! is_newer_version "$from" "$to"; then log "no newer release: current=$from latest=$to"; return 0; fi
  audit upgrade requested "$from" "$to" "pending"
  if ! snapshot="$(snapshot_release "$from")"; then
    audit upgrade failed "$from" "$to" "snapshot-failed"
    fail "could not create release snapshot"
  fi
  if XUANWU_VERSION="$to" \
    XUANWU_AUDIT_ACTOR="$ACTOR" XUANWU_AUDIT_ACTOR_KIND="$ACTOR_KIND" \
    XUANWU_AUDIT_REF="$AUDIT_REF" XUANWU_AUDIT_REASON="$REASON" \
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

job_field() {
  local job_dir="$1" name="$2"
  [ -f "$job_dir/$name" ] || fail "release update job is missing field: $name"
  sed -n '1p' "$job_dir/$name"
}

write_job_field() {
  local job_dir="$1" name="$2" value="$3" staged
  staged="$job_dir/.$name.$$"
  printf '%s\n' "$value" > "$staged"
  chmod 600 "$staged"
  mv -f "$staged" "$job_dir/$name"
}

valid_job_id() {
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9-]{0,79}$'
}

pending_worker_exit() {
  local status="$1" state
  if [ -n "${ACTIVE_JOB_DIR:-}" ] && [ -d "$ACTIVE_JOB_DIR" ]; then
    state="$(sed -n '1p' "$ACTIVE_JOB_DIR/state" 2>/dev/null || true)"
    if [ "$state" = "running" ] || [ "$state" = "pending" ]; then
      write_job_field "$ACTIVE_JOB_DIR" state failed
      write_job_field "$ACTIVE_JOB_DIR" error_code "updater_exit_$status"
      write_job_field "$ACTIVE_JOB_DIR" updated_at "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    fi
  fi
  rm -f "$JOBS_DIR/active" 2>/dev/null || true
  rmdir "$JOBS_DIR/worker.lock" 2>/dev/null || true
}

apply_pending_upgrade() {
  local job_id job_dir expected_from target backup_dir rehearsal_dir audit_ref
  umask 077
  mkdir -p "$JOBS_DIR"
  chmod 700 "$JOBS_DIR" 2>/dev/null || true
  mkdir "$JOBS_DIR/worker.lock" 2>/dev/null || fail "another release update worker is active"
  trap 'pending_worker_exit $?' EXIT
  [ -f "$JOBS_DIR/pending" ] || fail "no pending release update job"
  job_id="$(sed -n '1p' "$JOBS_DIR/pending")"
  valid_job_id "$job_id" || fail "pending release update job id is invalid"
  job_dir="$JOBS_DIR/$job_id"
  [ -d "$job_dir" ] || fail "pending release update job directory is missing"
  ACTIVE_JOB_DIR="$job_dir"
  mv -f "$JOBS_DIR/pending" "$JOBS_DIR/active"
  write_job_field "$job_dir" state running
  write_job_field "$job_dir" updated_at "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  expected_from="$(job_field "$job_dir" from_version)"
  target="$(job_field "$job_dir" target_version)"
  metadata_version_from_value "$expected_from" >/dev/null
  metadata_version_from_value "$target" >/dev/null
  [ "$(current_version)" = "$expected_from" ] \
    || fail "installed version changed after the update was requested"

  backup_dir="$BACKUP_DIR/xuanwu-backup-$(date -u '+%Y%m%dT%H%M%SZ')-$job_id"
  rehearsal_dir="$JOBS_DIR/$job_id/restore-rehearsal"
  audit_ref="release-update:$job_id"
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR" 2>/dev/null || true
  "$BIN_PATH" backup export --state-dir "$STATE_DIR" --db "$DB_PATH" \
    --output "$backup_dir" --retain 3 --actor runner-ui --actor-kind user \
    --audit-ref "$audit_ref" --reason "pre-upgrade backup" --json >> "$job_dir/worker.log" 2>&1
  "$BIN_PATH" backup verify --input "$backup_dir" --json >> "$job_dir/worker.log" 2>&1
  "$BIN_PATH" backup import --input "$backup_dir" --target-state-dir "$rehearsal_dir" --apply \
    --actor runner-ui --actor-kind user --audit-ref "$audit_ref" \
    --reason "pre-upgrade restore rehearsal" --json >> "$job_dir/worker.log" 2>&1
  rm -rf "$rehearsal_dir"
  write_job_field "$job_dir" backup_ref "$backup_dir"

  ACTOR="runner-ui"
  ACTOR_KIND="user"
  AUDIT_REF="$audit_ref"
  REASON="user approved release update from Runner UI"
  BACKUP_REF="$backup_dir"
  APPLY=true
  CONFIRM_BACKUP_TESTED=true
  TARGET_VERSION="$target"
  upgrade_release >> "$job_dir/worker.log" 2>&1
  [ "$(current_version)" = "$target" ] || fail "post-upgrade version verification failed"
  write_job_field "$job_dir" state succeeded
  write_job_field "$job_dir" updated_at "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
}

metadata_version_from_value() {
  printf '%s' "$1" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$' \
    || fail "release update job contains an invalid version"
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
  apply-pending) apply_pending_upgrade ;;
  upgrade) upgrade_release ;;
  rollback) rollback_release ;;
  help|-h|--help) usage ;;
  *) usage >&2; exit 64 ;;
esac
