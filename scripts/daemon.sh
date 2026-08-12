#!/usr/bin/env bash
set -euo pipefail

# Lifecycle boundary for a release installation. It intentionally owns only the
# service registration: SQLite state, tokens, and user data are never removed.
SERVICE_NAME="${XUANWU_SERVICE_NAME:-xuanwu}"
LABEL="${XUANWU_LAUNCHD_LABEL:-com.xiaobei.xuanwu}"
WEB_LABEL="${LABEL}.web"
CORE_LABEL="${LABEL}.core"
AGENTIC_LABEL="${LABEL}.agentic"
ADDR="${XUANWU_ADDR:-0.0.0.0:3008}"
INSTALL_DIR="${XUANWU_INSTALL_DIR:-$HOME/.local/bin}"
STATE_DIR="${XUANWU_STATE_DIR:-$HOME/.local/state/xuanwu}"
AUTH_TOKEN_FILE="${XUANWU_AUTH_TOKEN_FILE:-$STATE_DIR/auth_token}"
BIN_PATH="${XUANWU_BINARY:-$INSTALL_DIR/xuanwu}"
LOG_DIR="${XUANWU_LOG_DIR:-$STATE_DIR/logs}"
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
WEB_PLIST="$HOME/Library/LaunchAgents/$WEB_LABEL.plist"
CORE_PLIST="$HOME/Library/LaunchAgents/$CORE_LABEL.plist"
AGENTIC_PLIST="$HOME/Library/LaunchAgents/$AGENTIC_LABEL.plist"
UNIT_FILE="$HOME/.config/systemd/user/$SERVICE_NAME.service"
WEB_UNIT_FILE="$HOME/.config/systemd/user/$SERVICE_NAME-web.service"
CORE_UNIT_FILE="$HOME/.config/systemd/user/$SERVICE_NAME-core.service"
AGENTIC_UNIT_FILE="$HOME/.config/systemd/user/$SERVICE_NAME-agentic.service"
AUDIT_LOG="$LOG_DIR/daemon-lifecycle.log"

usage() {
  cat <<'HELP'
Usage: xuanwu-daemon <start|stop|restart|status|doctor|uninstall>

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
  if [ -f "$WEB_PLIST" ] && [ -f "$CORE_PLIST" ] && [ -f "$AGENTIC_PLIST" ]; then
    launchctl enable "$DOMAIN/$CORE_LABEL"
    launchctl enable "$DOMAIN/$AGENTIC_LABEL"
    launchctl enable "$DOMAIN/$WEB_LABEL"
    launchctl bootstrap "$DOMAIN" "$CORE_PLIST" >/dev/null 2>&1 || true
    launchctl bootstrap "$DOMAIN" "$AGENTIC_PLIST" >/dev/null 2>&1 || true
    launchctl bootstrap "$DOMAIN" "$WEB_PLIST" >/dev/null 2>&1 || true
    launchctl kickstart -k "$DOMAIN/$CORE_LABEL"
    launchctl kickstart -k "$DOMAIN/$AGENTIC_LABEL"
    launchctl kickstart -k "$DOMAIN/$WEB_LABEL"
    return
  fi
  [ -f "$PLIST" ] || { echo "[daemon] missing launchd split plists: $WEB_PLIST $CORE_PLIST $AGENTIC_PLIST" >&2; return 1; }
  launchctl enable "$DOMAIN/$LABEL"
  launchctl bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true
  launchctl kickstart -k "$DOMAIN/$LABEL"
}

stop_macos() {
  launchctl disable "$DOMAIN/$WEB_LABEL" >/dev/null 2>&1 || true
  launchctl disable "$DOMAIN/$CORE_LABEL" >/dev/null 2>&1 || true
  launchctl disable "$DOMAIN/$AGENTIC_LABEL" >/dev/null 2>&1 || true
  launchctl bootout "$DOMAIN/$WEB_LABEL" >/dev/null 2>&1 || true
  launchctl bootout "$DOMAIN/$CORE_LABEL" >/dev/null 2>&1 || true
  launchctl bootout "$DOMAIN/$AGENTIC_LABEL" >/dev/null 2>&1 || true
  launchctl disable "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || launchctl bootout "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true
}

start_linux() {
  systemctl --user daemon-reload
  if [ -f "$WEB_UNIT_FILE" ] && [ -f "$CORE_UNIT_FILE" ] && [ -f "$AGENTIC_UNIT_FILE" ]; then
    systemctl --user enable --now "$SERVICE_NAME-core.service" "$SERVICE_NAME-agentic.service" "$SERVICE_NAME-web.service"
  else
    systemctl --user enable --now "$SERVICE_NAME.service"
  fi
}

stop_linux() {
  systemctl --user disable --now "$SERVICE_NAME-web.service" >/dev/null 2>&1 || true
  systemctl --user disable --now "$SERVICE_NAME-core.service" >/dev/null 2>&1 || true
  systemctl --user disable --now "$SERVICE_NAME-agentic.service" >/dev/null 2>&1 || true
  systemctl --user disable --now "$SERVICE_NAME.service" >/dev/null 2>&1 || true
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
    Darwin)
      if [ -f "$WEB_PLIST" ] && [ -f "$CORE_PLIST" ] && [ -f "$AGENTIC_PLIST" ]; then
        launchctl kickstart -k "$DOMAIN/$CORE_LABEL"
        launchctl kickstart -k "$DOMAIN/$AGENTIC_LABEL"
        launchctl kickstart -k "$DOMAIN/$WEB_LABEL"
      else
        launchctl kickstart -k "$DOMAIN/$LABEL"
      fi
      ;;
    Linux)
      if [ -f "$WEB_UNIT_FILE" ] && [ -f "$CORE_UNIT_FILE" ] && [ -f "$AGENTIC_UNIT_FILE" ]; then
        systemctl --user restart "$SERVICE_NAME-core.service" "$SERVICE_NAME-agentic.service" "$SERVICE_NAME-web.service"
      else
        systemctl --user restart "$SERVICE_NAME.service"
      fi
      ;;
    *) echo "[daemon] unsupported platform: $(uname -s)" >&2; return 1 ;;
  esac
}

uninstall_service() {
  stop_service
  case "$(uname -s)" in
    Darwin) rm -f "$PLIST" "$WEB_PLIST" "$CORE_PLIST" "$AGENTIC_PLIST" ;;
    Linux) rm -f "$UNIT_FILE" "$WEB_UNIT_FILE" "$CORE_UNIT_FILE" "$AGENTIC_UNIT_FILE"; systemctl --user daemon-reload ;;
  esac
}

run_mutation() {
  local action="$1" operation="$2"
  if [ "${XUANWU_MANAGED_EXECUTION:-}" = "1" ] ||
    { [ -n "${PI_PACKAGE_DIR:-}" ] && [ -n "${XUANWU_CODEX_SERVER_MODE:-}" ]; }; then
    echo "[deploy-guard] denied: live service mutation cannot run from a Runner-managed provider process." >&2
    return 78
  fi
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
      if [ -f "$WEB_PLIST" ] && [ -f "$CORE_PLIST" ] && [ -f "$AGENTIC_PLIST" ]; then
        for label in "$WEB_LABEL" "$CORE_LABEL" "$AGENTIC_LABEL"; do
          echo "[daemon] manager=launchd label=$label"
          launchctl print "$DOMAIN/$label" 2>&1 | awk '/state =|pid =|last exit code =/ { print "[daemon] " $0 }'
        done
      else
        echo "[daemon] manager=launchd label=$LABEL"
        launchctl print "$DOMAIN/$LABEL" 2>&1 | awk '/state =|pid =|last exit code =/ { print "[daemon] " $0 }'
      fi
      ;;
    Linux)
      if [ -f "$WEB_UNIT_FILE" ] && [ -f "$CORE_UNIT_FILE" ] && [ -f "$AGENTIC_UNIT_FILE" ]; then
        for service in "$SERVICE_NAME-core.service" "$SERVICE_NAME-agentic.service" "$SERVICE_NAME-web.service"; do
          echo "[daemon] manager=systemd service=$service"
          systemctl --user is-enabled "$service" 2>&1 | sed 's/^/[daemon] enabled=/'
          systemctl --user is-active "$service" 2>&1 | sed 's/^/[daemon] active=/'
        done
      else
        echo "[daemon] manager=systemd service=$SERVICE_NAME.service"
        systemctl --user is-enabled "$SERVICE_NAME.service" 2>&1 | sed 's/^/[daemon] enabled=/'
        systemctl --user is-active "$SERVICE_NAME.service" 2>&1 | sed 's/^/[daemon] active=/'
      fi
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
