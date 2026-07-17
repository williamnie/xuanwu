#!/usr/bin/env bash
set -euo pipefail

# Lifecycle boundary for a release installation. It intentionally owns only the
# service registration: SQLite state, tokens, and user data are never removed.
SERVICE_NAME="${CODEX_RUNNER_SERVICE_NAME:-codex-issue-runner}"
LABEL="${CODEX_RUNNER_LAUNCHD_LABEL:-com.xiaobei.codex-issue-runner}"
ADDR="${CODEX_RUNNER_ADDR:-0.0.0.0:3008}"
INSTALL_DIR="${CODEX_RUNNER_INSTALL_DIR:-$HOME/.local/bin}"
STATE_DIR="${CODEX_RUNNER_STATE_DIR:-$HOME/.local/state/codex-issue-runner}"
AUTH_TOKEN_FILE="${CODEX_RUNNER_AUTH_TOKEN_FILE:-$STATE_DIR/auth_token}"
BIN_PATH="${CODEX_RUNNER_BINARY:-$INSTALL_DIR/codex-issue-runner}"
LOG_DIR="${CODEX_RUNNER_LOG_DIR:-$STATE_DIR/logs}"
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UNIT_FILE="$HOME/.config/systemd/user/$SERVICE_NAME.service"
AUDIT_LOG="$LOG_DIR/daemon-lifecycle.log"

usage() {
  cat <<'HELP'
Usage: codex-issue-runner-daemon <start|stop|restart|status|doctor|uninstall>

This command manages the launchd/user-systemd registration created by
install-release.sh. `uninstall` removes only the service registration; state,
SQLite data, auth token, and logs stay in place for a later reinstall.
HELP
}

service_url() {
  if [[ "$ADDR" == 0.0.0.0:* ]]; then
    printf 'http://127.0.0.1:%s' "${ADDR##*:}"
  elif [[ "$ADDR" == :* ]]; then
    printf 'http://127.0.0.1%s' "$ADDR"
  else
    printf 'http://%s' "$ADDR"
  fi
}

audit() {
  mkdir -p "$LOG_DIR"
  chmod 700 "$LOG_DIR" 2>/dev/null || true
  printf '%s action=%s outcome=%s platform=%s service=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" "$2" "$(uname -s)" "$SERVICE_NAME" >> "$AUDIT_LOG"
  chmod 600 "$AUDIT_LOG" 2>/dev/null || true
}

start_macos() {
  [ -f "$PLIST" ] || { echo "[daemon] missing launchd plist: $PLIST" >&2; return 1; }
  launchctl bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true
  launchctl enable "$DOMAIN/$LABEL"
  launchctl kickstart -k "$DOMAIN/$LABEL"
}

stop_macos() {
  launchctl disable "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || launchctl bootout "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true
}

start_linux() {
  systemctl --user daemon-reload
  systemctl --user enable --now "$SERVICE_NAME.service"
}

stop_linux() {
  systemctl --user disable --now "$SERVICE_NAME.service"
}

start_service() {
  case "$(uname -s)" in
    Darwin) start_macos ;;
    Linux) start_linux ;;
    *) echo "[daemon] unsupported platform: $(uname -s)" >&2; return 1 ;;
  esac
}

stop_service() {
  case "$(uname -s)" in
    Darwin) stop_macos ;;
    Linux) stop_linux ;;
    *) echo "[daemon] unsupported platform: $(uname -s)" >&2; return 1 ;;
  esac
}

restart_service() {
  case "$(uname -s)" in
    Darwin) launchctl kickstart -k "$DOMAIN/$LABEL" ;;
    Linux) systemctl --user restart "$SERVICE_NAME.service" ;;
    *) echo "[daemon] unsupported platform: $(uname -s)" >&2; return 1 ;;
  esac
}

uninstall_service() {
  stop_service
  case "$(uname -s)" in
    Darwin) rm -f "$PLIST" ;;
    Linux) rm -f "$UNIT_FILE"; systemctl --user daemon-reload ;;
  esac
}

run_mutation() {
  local action="$1" operation="$2"
  audit "$action" requested
  if "$operation"; then
    audit "$action" applied
    return 0
  fi
  audit "$action" failed
  return 1
}

status_service() {
  case "$(uname -s)" in
    Darwin)
      echo "[daemon] manager=launchd label=$LABEL"
      launchctl print "$DOMAIN/$LABEL" 2>&1 | awk '/state =|pid =|last exit code =/ { print "[daemon] " $0 }'
      ;;
    Linux)
      echo "[daemon] manager=systemd service=$SERVICE_NAME.service"
      systemctl --user is-enabled "$SERVICE_NAME.service" 2>&1 | sed 's/^/[daemon] enabled=/'
      systemctl --user is-active "$SERVICE_NAME.service" 2>&1 | sed 's/^/[daemon] active=/'
      loginctl show-user "$USER" -p Linger 2>&1 | sed 's/^/[daemon] /'
      ;;
    *) echo "[daemon] unsupported platform: $(uname -s)" >&2; return 1 ;;
  esac
  echo "[daemon] health=$(service_url)/health"
  curl -fsS "$(service_url)/health" >/dev/null && echo "[daemon] health=ok" || echo "[daemon] health=unreachable"
}

doctor_service() {
  status_service
  [ -x "$BIN_PATH" ] || { echo "[daemon] missing binary: $BIN_PATH" >&2; return 1; }
  "$BIN_PATH" system doctor --addr "$ADDR" --token-file "$AUTH_TOKEN_FILE" --json
}

command="${1:-}"
case "$command" in
  start)
    run_mutation start start_service
    ;;
  stop)
    run_mutation stop stop_service
    ;;
  restart)
    run_mutation restart restart_service
    ;;
  status)
    status_service
    ;;
  doctor)
    doctor_service
    ;;
  uninstall)
    run_mutation uninstall uninstall_service
    echo "[daemon] service registration removed; preserved state: $STATE_DIR"
    ;;
  -h|--help|help|"")
    usage
    ;;
  *)
    usage >&2
    exit 64
    ;;
esac
