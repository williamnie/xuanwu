#!/usr/bin/env bash
set -euo pipefail

REPO="${CODEX_RUNNER_REPO:-williamnie/codex-issue-runner}"
VERSION="${CODEX_RUNNER_VERSION:-latest}"
ADDR="${CODEX_RUNNER_ADDR:-0.0.0.0:3008}"
LABEL="${CODEX_RUNNER_LAUNCHD_LABEL:-com.xiaobei.codex-issue-runner}"
SERVICE_NAME="${CODEX_RUNNER_SERVICE_NAME:-codex-issue-runner}"
INSTALL_DIR="${CODEX_RUNNER_INSTALL_DIR:-$HOME/.local/bin}"
STATE_DIR="${CODEX_RUNNER_STATE_DIR:-$HOME/.local/state/codex-issue-runner}"
LOG_DIR="${CODEX_RUNNER_LOG_DIR:-$STATE_DIR/logs}"
DB_PATH="${CODEX_RUNNER_DB:-${CODEX_RUNNER_DEPLOY_DB:-$STATE_DIR/runner.db}}"
AUTH_TOKEN_FILE="${CODEX_RUNNER_AUTH_TOKEN_FILE:-$STATE_DIR/auth_token}"
AUTH_TOKEN="${CODEX_RUNNER_AUTH_TOKEN:-}"
BIN_PATH="$INSTALL_DIR/codex-issue-runner"
PATH_VALUE="${CODEX_RUNNER_PATH:-$PATH}"
CODEX_CMD="${CODEX_RUNNER_CODEX_CMD:-}"
CODEX_SERVER_MODE="${CODEX_RUNNER_CODEX_SERVER_MODE:-cli}"
CODEX_APP_CMD="${CODEX_RUNNER_CODEX_APP_CMD:-}"

usage() {
  cat <<'HELP'
Install and run Codex Issue Runner from GitHub Releases.

Usage:
  curl -fsSL https://raw.githubusercontent.com/williamnie/codex-issue-runner/main/scripts/install-release.sh | bash

Useful environment variables:
  CODEX_RUNNER_VERSION=v0.1.0          Install a fixed release tag instead of latest
  CODEX_RUNNER_ADDR=0.0.0.0:3008       Service listen address
  CODEX_RUNNER_INSTALL_DIR=~/.local/bin Binary install directory
  CODEX_RUNNER_STATE_DIR=~/.local/state/codex-issue-runner
  CODEX_RUNNER_CODEX_CMD=/path/to/codex Codex CLI path
  CODEX_RUNNER_CODEX_SERVER_MODE=cli|app Codex server backend
  CODEX_RUNNER_CODEX_APP_CMD=/path/to/app/codex Codex App bundled server command
  CODEX_RUNNER_AUTH_TOKEN=...          Custom bearer token for remote access
  CODEX_RUNNER_AUTH_TOKEN_FILE=...     Generated token file path
HELP
}

log() { printf '[install] %s\n' "$*"; }
fail() { printf '[install] ERROR: %s\n' "$*" >&2; exit 1; }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "missing required command: $1"
  fi
}

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  printf '%s' "$value"
}

service_url() {
  if [[ "$ADDR" == 0.0.0.0:* ]]; then
    printf 'http://127.0.0.1:%s' "${ADDR##*:}"
    return
  fi
  if [[ "$ADDR" == :* ]]; then
    printf 'http://127.0.0.1%s' "$ADDR"
  else
    printf 'http://%s' "$ADDR"
  fi
}

detect_platform() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *) fail "unsupported OS: $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="amd64" ;;
    *) fail "unsupported architecture: $(uname -m)" ;;
  esac
  printf '%s %s' "$os" "$arch"
}

asset_url() {
  local os="$1" arch="$2" asset
  asset="codex-issue-runner_${os}_${arch}.tar.gz"
  if [ "$VERSION" = "latest" ]; then
    printf 'https://github.com/%s/releases/latest/download/%s' "$REPO" "$asset"
    return
  fi
  printf 'https://github.com/%s/releases/download/%s/%s' "$REPO" "$VERSION" "$asset"
}

resolve_codex_cmd() {
  if [ -n "$CODEX_CMD" ]; then
    printf '%s' "$CODEX_CMD"
    return
  fi
  if ! command -v codex >/dev/null 2>&1; then
    fail "codex command not found; set CODEX_RUNNER_CODEX_CMD=/absolute/path/to/codex"
  fi
  command -v codex
}

download_binary() {
  local os="$1" arch="$2" url tmp archive
  url="$(asset_url "$os" "$arch")"
  tmp="$(mktemp -d)"
  archive="$tmp/codex-issue-runner.tar.gz"
  log "downloading $url"
  curl -fL --retry 3 -o "$archive" "$url"
  LC_ALL=C tar -xzf "$archive" -C "$tmp"
  [ -x "$tmp/codex-issue-runner" ] || fail "release asset does not contain executable binary"
  mkdir -p "$INSTALL_DIR" "$STATE_DIR" "$LOG_DIR" "$(dirname "$AUTH_TOKEN_FILE")"
  install -m 0755 "$tmp/codex-issue-runner" "$BIN_PATH"
  if [ -d "$tmp/web" ]; then
    rm -rf "$STATE_DIR/web"
    mkdir -p "$STATE_DIR"
    cp -R "$tmp/web" "$STATE_DIR/web"
  fi
  if [ -d "$tmp/pi-coding-agent" ]; then
    rm -rf "$STATE_DIR/pi-coding-agent"
    cp -R "$tmp/pi-coding-agent" "$STATE_DIR/pi-coding-agent"
  fi
  if [ -f "$tmp/photon_rs_bg.wasm" ]; then
    cp "$tmp/photon_rs_bg.wasm" "$INSTALL_DIR/photon_rs_bg.wasm"
  fi
  rm -rf "$tmp"
  log "installed binary: $BIN_PATH"
}

wait_until_ready() {
  local url="$1"
  for _ in {1..120}; do
    if curl -fsS "$url/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

write_macos_plist() {
  local plist="$1" codex_cmd="$2"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$BIN_PATH")</string>
    <string>serve</string>
    <string>--addr</string>
    <string>$(xml_escape "$ADDR")</string>
    <string>--state-dir</string>
    <string>$(xml_escape "$STATE_DIR")</string>
    <string>--db</string>
    <string>$(xml_escape "$DB_PATH")</string>
    <string>--web-dir</string>
    <string>$(xml_escape "$STATE_DIR/web")</string>
    <string>--codex-cmd</string>
    <string>$(xml_escape "$codex_cmd")</string>
$(auth_token_file_macos_args)
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$(xml_escape "$HOME")</string>
    <key>PATH</key>
    <string>$(xml_escape "$PATH_VALUE")</string>
    <key>PI_PACKAGE_DIR</key>
    <string>$(xml_escape "$STATE_DIR/pi-coding-agent")</string>
    <key>CODEX_RUNNER_CODEX_SERVER_MODE</key>
    <string>$(xml_escape "$CODEX_SERVER_MODE")</string>
    <key>CODEX_RUNNER_CODEX_APP_CMD</key>
    <string>$(xml_escape "$CODEX_APP_CMD")</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$LOG_DIR/launchd.out.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$LOG_DIR/launchd.err.log")</string>
</dict>
</plist>
PLIST
}

auth_token_file_macos_args() {
  if [ -n "$AUTH_TOKEN_FILE" ]; then
    cat <<ARGS
    <string>--auth-token-file</string>
    <string>$(xml_escape "$AUTH_TOKEN_FILE")</string>
ARGS
  fi
}

auth_token_file_systemd_args() {
  if [ -n "$AUTH_TOKEN_FILE" ]; then
    printf ' --auth-token-file %q' "$AUTH_TOKEN_FILE"
  fi
}

write_custom_auth_token_file() {
  if [ -n "$AUTH_TOKEN" ]; then
    mkdir -p "$(dirname "$AUTH_TOKEN_FILE")"
    umask 077
    printf '%s\n' "$AUTH_TOKEN" > "$AUTH_TOKEN_FILE"
  fi
}

install_macos_launchd() {
  local codex_cmd plist domain url
  codex_cmd="$(resolve_codex_cmd)"
  plist="$HOME/Library/LaunchAgents/$LABEL.plist"
  domain="gui/$(id -u)"
  mkdir -p "$HOME/Library/LaunchAgents"
  write_macos_plist "$plist" "$codex_cmd"
  plutil -lint "$plist" >/dev/null
  launchctl bootout "$domain" "$plist" >/dev/null 2>&1 || true
  launchctl bootstrap "$domain" "$plist"
  launchctl enable "$domain/$LABEL" >/dev/null 2>&1 || true
  launchctl kickstart -k "$domain/$LABEL"
  url="$(service_url)"
  wait_until_ready "$url" || fail "service did not become ready at $url"
  log "launchd service installed: $plist"
}

install_linux_systemd() {
  local codex_cmd unit_dir unit_file url
  require_cmd systemctl
  codex_cmd="$(resolve_codex_cmd)"
  unit_dir="$HOME/.config/systemd/user"
  unit_file="$unit_dir/$SERVICE_NAME.service"
  mkdir -p "$unit_dir"
  cat > "$unit_file" <<UNIT
[Unit]
Description=Codex Issue Runner
After=network.target

[Service]
Type=simple
WorkingDirectory=$STATE_DIR
Environment=HOME=$HOME
Environment=PATH=$PATH_VALUE
Environment=PI_PACKAGE_DIR=$STATE_DIR/pi-coding-agent
Environment="CODEX_RUNNER_CODEX_SERVER_MODE=$CODEX_SERVER_MODE"
Environment="CODEX_RUNNER_CODEX_APP_CMD=$CODEX_APP_CMD"
ExecStart=$BIN_PATH serve --addr $ADDR --state-dir $STATE_DIR --db $DB_PATH --web-dir $STATE_DIR/web --codex-cmd $codex_cmd$(auth_token_file_systemd_args)
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now "$SERVICE_NAME.service"
  systemctl --user restart "$SERVICE_NAME.service"
  url="$(service_url)"
  wait_until_ready "$url" || fail "service did not become ready at $url"
  log "systemd user service installed: $unit_file"
}

main() {
  if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
    usage
    exit 0
  fi
  require_cmd curl
  require_cmd tar
  require_cmd uname
  local os arch
  read -r os arch < <(detect_platform)
  download_binary "$os" "$arch"
  write_custom_auth_token_file
  case "$os" in
    darwin) install_macos_launchd ;;
    linux) install_linux_systemd ;;
  esac
  log "ready: $(service_url)/"
  log "data: $STATE_DIR"
}

main "$@"
