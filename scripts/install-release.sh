#!/usr/bin/env bash
set -euo pipefail

if [ "${CODEX_RUNNER_MANAGED_EXECUTION:-}" = "1" ] ||
  { [ -n "${PI_PACKAGE_DIR:-}" ] && [ -n "${CODEX_RUNNER_CODEX_SERVER_MODE:-}" ]; }; then
  echo "[deploy-guard] denied: live deployment cannot run from a Runner-managed provider process." >&2
  exit 78
fi

REPO="${CODEX_RUNNER_REPO:-williamnie/codex-issue-runner}"
VERSION="${CODEX_RUNNER_VERSION:-latest}"
VERIFY_ATTESTATION="${CODEX_RUNNER_VERIFY_ATTESTATION:-auto}"
ADDR="${CODEX_RUNNER_ADDR:-0.0.0.0:3008}"
CORE_ADDR="${CODEX_RUNNER_CORE_ADDR:-127.0.0.1:3009}"
AGENTIC_ADDR="${CODEX_RUNNER_AGENTIC_ADDR:-127.0.0.1:3010}"
LABEL="${CODEX_RUNNER_LAUNCHD_LABEL:-com.xiaobei.codex-issue-runner}"
WEB_LABEL="${LABEL}.web"
CORE_LABEL="${LABEL}.core"
AGENTIC_LABEL="${LABEL}.agentic"
SERVICE_NAME="${CODEX_RUNNER_SERVICE_NAME:-codex-issue-runner}"
INSTALL_DIR="${CODEX_RUNNER_INSTALL_DIR:-$HOME/.local/bin}"
STATE_DIR="${CODEX_RUNNER_STATE_DIR:-$HOME/.local/state/codex-issue-runner}"
LOG_DIR="${CODEX_RUNNER_LOG_DIR:-$STATE_DIR/logs}"
DB_PATH="${CODEX_RUNNER_DB:-${CODEX_RUNNER_DEPLOY_DB:-$STATE_DIR/runner.db}}"
AUTH_TOKEN_FILE="${CODEX_RUNNER_AUTH_TOKEN_FILE:-$STATE_DIR/auth_token}"
AUTH_TOKEN="${CODEX_RUNNER_AUTH_TOKEN:-}"
BIN_PATH="$INSTALL_DIR/codex-issue-runner"
CLAUDE_SDK_EXECUTABLE_PATH="$BIN_PATH.claude-agent-sdk"
DAEMON_PATH="$INSTALL_DIR/codex-issue-runner-daemon"
INSTALLER_PATH="$INSTALL_DIR/codex-issue-runner-install"
UPDATER_PATH="$INSTALL_DIR/codex-issue-runner-update"
PATH_VALUE="${CODEX_RUNNER_PATH:-$PATH}"
CODEX_CMD="${CODEX_RUNNER_CODEX_CMD:-}"
CODEX_SERVER_MODE="${CODEX_RUNNER_CODEX_SERVER_MODE:-cli}"
CODEX_APP_CMD="${CODEX_RUNNER_CODEX_APP_CMD:-}"
CLAUDE_MODE="${CODEX_RUNNER_CLAUDE_MODE:-sdk}"
CLAUDE_AUTH_MODE="${CODEX_RUNNER_CLAUDE_AUTH_MODE:-}"
CLAUDE_API_BASE_URL="${CODEX_RUNNER_CLAUDE_API_BASE_URL:-${ANTHROPIC_BASE_URL:-}}"
CLAUDE_API_PATH="${CODEX_RUNNER_CLAUDE_API_PATH:-}"
CLAUDE_API_KEY="${CODEX_RUNNER_CLAUDE_API_KEY:-${ANTHROPIC_API_KEY:-}}"
CLAUDE_API_KEY_FILE="${CODEX_RUNNER_CLAUDE_API_KEY_FILE:-$STATE_DIR/claude_api_key}"
CLAUDE_PLATFORM_CONFIG_DIR="${CODEX_RUNNER_CLAUDE_PLATFORM_CONFIG_DIR:-${ANTHROPIC_CONFIG_DIR:-}}"
CLAUDE_PLATFORM_PROFILE="${CODEX_RUNNER_CLAUDE_PLATFORM_PROFILE:-${ANTHROPIC_PROFILE:-}}"
if [ -z "$CLAUDE_AUTH_MODE" ]; then
  if [ "$CLAUDE_MODE" = "cli-fallback" ] && [ -z "$CLAUDE_API_KEY" ]; then
    CLAUDE_AUTH_MODE="local-cli"
  else
    CLAUDE_AUTH_MODE="environment"
  fi
fi
AUDIT_LOG="$LOG_DIR/release-upgrade.log"
RESOLVED_VERSION=""

usage() {
  cat <<'HELP'
Install and run Xuanwu from the codex-issue-runner compatibility release.

Usage:
  curl -fsSL https://raw.githubusercontent.com/williamnie/codex-issue-runner/main/scripts/install-release.sh | bash

Useful environment variables:
  CODEX_RUNNER_VERSION=v0.1.0          Install a fixed release tag instead of latest
  CODEX_RUNNER_ADDR=0.0.0.0:3008       Service listen address
  CODEX_RUNNER_CORE_ADDR=127.0.0.1:3009 Internal Core listen address
  CODEX_RUNNER_AGENTIC_ADDR=127.0.0.1:3010 Internal Agentic Worker listen address
  CODEX_RUNNER_INSTALL_DIR=~/.local/bin Binary install directory
  CODEX_RUNNER_STATE_DIR=~/.local/state/codex-issue-runner
  CODEX_RUNNER_CODEX_CMD=/path/to/codex Codex CLI path
  CODEX_RUNNER_CODEX_SERVER_MODE=cli|app Codex server backend
  CODEX_RUNNER_CODEX_APP_CMD=/path/to/app/codex Codex App bundled server command
  CODEX_RUNNER_CLAUDE_MODE=sdk|cli-fallback Claude provider mode
  CODEX_RUNNER_CLAUDE_AUTH_MODE=environment|local-cli|platform-profile
  CODEX_RUNNER_CLAUDE_API_BASE_URL=https://... Claude/Anthropic API base URL
  CODEX_RUNNER_CLAUDE_API_PATH=/... Optional path appended to the API base URL
  CODEX_RUNNER_CLAUDE_API_KEY=...     Claude API key (persisted to a mode-0600 state file)
  CODEX_RUNNER_CLAUDE_PLATFORM_CONFIG_DIR=... Anthropic profile config directory
  CODEX_RUNNER_CLAUDE_PLATFORM_PROFILE=... Anthropic profile name
  CODEX_RUNNER_AUTH_TOKEN=...          Custom bearer token for remote access
  CODEX_RUNNER_AUTH_TOKEN_FILE=...     Generated token file path
  CODEX_RUNNER_VERIFY_ATTESTATION=auto|require|skip

After installation, use `codex-issue-runner-daemon status|doctor|restart|uninstall`
and `codex-issue-runner-update check|upgrade|rollback`.
`uninstall` keeps the state directory and database.
HELP
}

log() { printf '[install] %s\n' "$*"; }
fail() { printf '[install] ERROR: %s\n' "$*" >&2; exit 1; }

case "$CLAUDE_AUTH_MODE" in
  environment) ;;
  local-cli) [ "$CLAUDE_MODE" = "cli-fallback" ] || fail "CODEX_RUNNER_CLAUDE_AUTH_MODE=local-cli requires cli-fallback mode" ;;
  platform-profile) [ "$CLAUDE_MODE" = "sdk" ] || fail "CODEX_RUNNER_CLAUDE_AUTH_MODE=platform-profile requires sdk mode" ;;
  *) fail "CODEX_RUNNER_CLAUDE_AUTH_MODE must be environment, local-cli, or platform-profile" ;;
esac
if [ -n "$CLAUDE_PLATFORM_PROFILE" ] && [[ ! "$CLAUDE_PLATFORM_PROFILE" =~ ^[A-Za-z0-9_.-]+$ || "$CLAUDE_PLATFORM_PROFILE" = "." || "$CLAUDE_PLATFORM_PROFILE" = ".." ]]; then
  fail "CODEX_RUNNER_CLAUDE_PLATFORM_PROFILE is invalid"
fi

audit() {
  local outcome="$1"
  mkdir -p "$LOG_DIR"
  chmod 700 "$LOG_DIR" 2>/dev/null || true
  printf '%s action=install outcome=%s version=%s actor=%q actor_kind=%q audit_ref=%q reason=%q\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$outcome" "${RESOLVED_VERSION:-$VERSION}" \
    "${CODEX_RUNNER_AUDIT_ACTOR:-${USER:-unknown}}" "${CODEX_RUNNER_AUDIT_ACTOR_KIND:-user}" \
    "${CODEX_RUNNER_AUDIT_REF:-shell:install-release}" "${CODEX_RUNNER_AUDIT_REASON:-manual install}" >> "$AUDIT_LOG"
  chmod 600 "$AUDIT_LOG" 2>/dev/null || true
}

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
  local addr="$1"
  if [[ "$addr" == 0.0.0.0:* ]]; then
    printf 'http://127.0.0.1:%s' "${addr##*:}"
    return
  fi
  if [[ "$addr" == :* ]]; then
    printf 'http://127.0.0.1%s' "$addr"
  else
    printf 'http://%s' "$addr"
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
  printf '%s %s\n' "$os" "$arch"
}

release_asset_url() {
  local asset="$1"
  if [ "$VERSION" = "latest" ]; then
    printf 'https://github.com/%s/releases/latest/download/%s' "$REPO" "$asset"
    return
  fi
  printf 'https://github.com/%s/releases/download/%s/%s' "$REPO" "$VERSION" "$asset"
}

checksum_for() {
  local checksums="$1" name="$2"
  awk -v name="$name" '{ file=$2; sub(/^\*/, "", file); if (file == name) { print $1; exit } }' "$checksums"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

verify_download() {
  local path="$1" name="$2" checksums="$3" expected actual
  expected="$(checksum_for "$checksums" "$name")"
  [ -n "$expected" ] || fail "checksums.txt has no entry for $name"
  actual="$(sha256_file "$path")"
  [ "$actual" = "$expected" ] || fail "SHA-256 mismatch for $name"
}

verify_attestation() {
  local archive="$1"
  case "$VERIFY_ATTESTATION" in
    skip) return 0 ;;
    auto|require) ;;
    *) fail "CODEX_RUNNER_VERIFY_ATTESTATION must be auto, require, or skip" ;;
  esac
  if ! command -v gh >/dev/null 2>&1; then
    [ "$VERIFY_ATTESTATION" = "require" ] && fail "gh is required for release attestation verification"
    log "warning: gh not found; SHA-256 verified but signed provenance was not checked"
    return 0
  fi
  gh attestation verify "$archive" --repo "$REPO" \
    --signer-workflow "$REPO/.github/workflows/release.yml" >/dev/null \
    || fail "GitHub artifact attestation verification failed"
  log "verified signed GitHub provenance"
}

release_version() {
  sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -n 1
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
  local os="$1" arch="$2" asset url tmp archive checksums metadata staged sdk_staged binary_version
  asset="codex-issue-runner_${os}_${arch}.tar.gz"
  url="$(release_asset_url "$asset")"
  tmp="$(mktemp -d)"
  archive="$tmp/codex-issue-runner.tar.gz"
  checksums="$tmp/checksums.txt"
  metadata="$tmp/release.json"
  log "downloading $url"
  curl -fL --retry 3 -o "$archive" "$url"
  curl -fsSL --retry 3 -o "$checksums" "$(release_asset_url checksums.txt)"
  curl -fsSL --retry 3 -o "$metadata" "$(release_asset_url release.json)"
  verify_download "$archive" "$asset" "$checksums"
  verify_download "$metadata" release.json "$checksums"
  RESOLVED_VERSION="$(release_version "$metadata")"
  [ -n "$RESOLVED_VERSION" ] || fail "release.json does not contain a version"
  if [ "$VERSION" != "latest" ] && [ "$RESOLVED_VERSION" != "$VERSION" ]; then
    fail "release metadata version $RESOLVED_VERSION does not match requested $VERSION"
  fi
  verify_attestation "$archive"
  LC_ALL=C tar -xzf "$archive" -C "$tmp"
  [ -x "$tmp/codex-issue-runner" ] || fail "release asset does not contain executable binary"
  [ -x "$tmp/codex-issue-runner.claude-agent-sdk" ] \
    || fail "release asset does not contain Claude Agent SDK native executable"
  binary_version="$("$tmp/codex-issue-runner" --version | awk 'NR == 1 { print $2 }')"
  [ "$binary_version" = "$RESOLVED_VERSION" ] \
    || fail "binary version $binary_version does not match release metadata $RESOLVED_VERSION"
  mkdir -p "$INSTALL_DIR" "$STATE_DIR" "$LOG_DIR" "$(dirname "$AUTH_TOKEN_FILE")"
  sdk_staged="$INSTALL_DIR/.codex-issue-runner.claude-agent-sdk.stage.$$"
  install -m 0755 "$tmp/codex-issue-runner.claude-agent-sdk" "$sdk_staged"
  mv -f "$sdk_staged" "$CLAUDE_SDK_EXECUTABLE_PATH"
  staged="$INSTALL_DIR/.codex-issue-runner.stage.$$"
  install -m 0755 "$tmp/codex-issue-runner" "$staged"
  mv -f "$staged" "$BIN_PATH"
  if [ -f "$tmp/daemon.sh" ]; then
    install -m 0755 "$tmp/daemon.sh" "$DAEMON_PATH"
  fi
  if [ -f "$tmp/install-release.sh" ]; then
    install -m 0755 "$tmp/install-release.sh" "$INSTALLER_PATH"
  fi
  if [ -f "$tmp/update-release.sh" ]; then
    install -m 0755 "$tmp/update-release.sh" "$UPDATER_PATH"
  fi
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

write_macos_plists() {
  local web_plist="$1" core_plist="$2" agentic_plist="$3" codex_cmd="$4"
  cat > "$web_plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$WEB_LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$BIN_PATH")</string>
    <string>serve</string>
    <string>--role</string>
    <string>web</string>
    <string>--addr</string>
    <string>$(xml_escape "$ADDR")</string>
    <string>--core-addr</string>
    <string>$(xml_escape "$CORE_ADDR")</string>
    <string>--web-dir</string>
    <string>$(xml_escape "$STATE_DIR/web")</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$(xml_escape "$HOME")</string>
    <key>PATH</key>
    <string>$(xml_escape "$PATH_VALUE")</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$LOG_DIR/launchd.web.out.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$LOG_DIR/launchd.web.err.log")</string>
</dict>
</plist>
PLIST

  cat > "$core_plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$CORE_LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$BIN_PATH")</string>
    <string>serve</string>
    <string>--role</string>
    <string>core</string>
    <string>--addr</string>
    <string>$(xml_escape "$CORE_ADDR")</string>
    <string>--agentic-addr</string>
    <string>$(xml_escape "$AGENTIC_ADDR")</string>
    <string>--state-dir</string>
    <string>$(xml_escape "$STATE_DIR")</string>
    <string>--db</string>
    <string>$(xml_escape "$DB_PATH")</string>
    <string>--auth-token-file</string>
    <string>$(xml_escape "$AUTH_TOKEN_FILE")</string>
    <string>--codex-cmd</string>
    <string>$(xml_escape "$codex_cmd")</string>
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
    <key>CODEX_RUNNER_CLAUDE_MODE</key>
    <string>$(xml_escape "$CLAUDE_MODE")</string>
    <key>CODEX_RUNNER_CLAUDE_AUTH_MODE</key>
    <string>$(xml_escape "$CLAUDE_AUTH_MODE")</string>
    <key>CODEX_RUNNER_CLAUDE_API_BASE_URL</key>
    <string>$(xml_escape "$CLAUDE_API_BASE_URL")</string>
    <key>CODEX_RUNNER_CLAUDE_API_PATH</key>
    <string>$(xml_escape "$CLAUDE_API_PATH")</string>
    <key>CODEX_RUNNER_CLAUDE_API_KEY_FILE</key>
    <string>$(xml_escape "$CLAUDE_API_KEY_FILE")</string>
    <key>CODEX_RUNNER_CLAUDE_PLATFORM_CONFIG_DIR</key>
    <string>$(xml_escape "$CLAUDE_PLATFORM_CONFIG_DIR")</string>
    <key>CODEX_RUNNER_CLAUDE_PLATFORM_PROFILE</key>
    <string>$(xml_escape "$CLAUDE_PLATFORM_PROFILE")</string>
    <key>CODEX_RUNNER_MANAGED_EXECUTION</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$LOG_DIR/launchd.out.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$LOG_DIR/launchd.err.log")</string>
</dict>
</plist>
PLIST

  cat > "$agentic_plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$AGENTIC_LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$BIN_PATH")</string>
    <string>serve</string>
    <string>--role</string>
    <string>agentic</string>
    <string>--addr</string>
    <string>$(xml_escape "$AGENTIC_ADDR")</string>
    <string>--state-dir</string>
    <string>$(xml_escape "$STATE_DIR")</string>
    <string>--db</string>
    <string>$(xml_escape "$DB_PATH")</string>
    <string>--auth-token-file</string>
    <string>$(xml_escape "$AUTH_TOKEN_FILE")</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$(xml_escape "$HOME")</string>
    <key>PATH</key>
    <string>$(xml_escape "$PATH_VALUE")</string>
    <key>PI_PACKAGE_DIR</key>
    <string>$(xml_escape "$STATE_DIR/pi-coding-agent")</string>
    <key>CODEX_RUNNER_MANAGED_EXECUTION</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$LOG_DIR/launchd.agentic.out.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$LOG_DIR/launchd.agentic.err.log")</string>
</dict>
</plist>
PLIST
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

write_claude_api_key_file() {
  if [ "$CLAUDE_AUTH_MODE" = "environment" ] && [ -n "$CLAUDE_API_KEY" ]; then
    mkdir -p "$(dirname "$CLAUDE_API_KEY_FILE")"
    umask 077
    printf '%s\n' "$CLAUDE_API_KEY" > "$CLAUDE_API_KEY_FILE"
    chmod 600 "$CLAUDE_API_KEY_FILE"
  fi
}

install_macos_launchd() {
  local codex_cmd web_plist core_plist agentic_plist legacy_plist domain web_url core_url agentic_url
  codex_cmd="$(resolve_codex_cmd)"
  web_plist="$HOME/Library/LaunchAgents/$WEB_LABEL.plist"
  core_plist="$HOME/Library/LaunchAgents/$CORE_LABEL.plist"
  agentic_plist="$HOME/Library/LaunchAgents/$AGENTIC_LABEL.plist"
  legacy_plist="$HOME/Library/LaunchAgents/$LABEL.plist"
  domain="gui/$(id -u)"
  mkdir -p "$HOME/Library/LaunchAgents"
  write_macos_plists "$web_plist" "$core_plist" "$agentic_plist" "$codex_cmd"
  plutil -lint "$web_plist" >/dev/null
  plutil -lint "$core_plist" >/dev/null
  plutil -lint "$agentic_plist" >/dev/null
  launchctl bootout "$domain/$LABEL" >/dev/null 2>&1 || launchctl bootout "$domain" "$legacy_plist" >/dev/null 2>&1 || true
  launchctl bootout "$domain/$WEB_LABEL" >/dev/null 2>&1 || true
  launchctl bootout "$domain/$CORE_LABEL" >/dev/null 2>&1 || true
  launchctl bootout "$domain/$AGENTIC_LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "$domain" "$core_plist"
  launchctl enable "$domain/$CORE_LABEL" >/dev/null 2>&1 || true
  launchctl kickstart -k "$domain/$CORE_LABEL"
  core_url="$(service_url "$CORE_ADDR")"
  wait_until_ready "$core_url" || fail "Core did not become ready at $core_url"
  launchctl bootstrap "$domain" "$agentic_plist"
  launchctl enable "$domain/$AGENTIC_LABEL" >/dev/null 2>&1 || true
  launchctl kickstart -k "$domain/$AGENTIC_LABEL"
  agentic_url="$(service_url "$AGENTIC_ADDR")"
  wait_until_ready "$agentic_url" || fail "Agentic Worker did not become ready at $agentic_url"
  launchctl bootstrap "$domain" "$web_plist"
  launchctl enable "$domain/$WEB_LABEL" >/dev/null 2>&1 || true
  launchctl kickstart -k "$domain/$WEB_LABEL"
  web_url="$(service_url "$ADDR")"
  wait_until_ready "$web_url" || fail "Web did not become ready at $web_url"
  log "launchd services installed: $web_plist $core_plist $agentic_plist"
}

install_linux_systemd() {
  local codex_cmd unit_dir web_unit core_unit agentic_unit web_url core_url agentic_url
  require_cmd systemctl
  require_cmd loginctl
  loginctl enable-linger "$USER" || fail "failed to enable user linger; systemd user service would stop after logout"
  codex_cmd="$(resolve_codex_cmd)"
  unit_dir="$HOME/.config/systemd/user"
  web_unit="$unit_dir/$SERVICE_NAME-web.service"
  core_unit="$unit_dir/$SERVICE_NAME-core.service"
  agentic_unit="$unit_dir/$SERVICE_NAME-agentic.service"
  mkdir -p "$unit_dir"
  cat > "$core_unit" <<UNIT
[Unit]
Description=Xuanwu Runner Core
After=network.target

[Service]
Type=simple
WorkingDirectory=$STATE_DIR
Environment=HOME=$HOME
Environment=PATH=$PATH_VALUE
Environment=PI_PACKAGE_DIR=$STATE_DIR/pi-coding-agent
Environment="CODEX_RUNNER_CODEX_SERVER_MODE=$CODEX_SERVER_MODE"
Environment="CODEX_RUNNER_CODEX_APP_CMD=$CODEX_APP_CMD"
Environment="CODEX_RUNNER_CLAUDE_MODE=$CLAUDE_MODE"
Environment="CODEX_RUNNER_CLAUDE_AUTH_MODE=$CLAUDE_AUTH_MODE"
Environment="CODEX_RUNNER_CLAUDE_API_BASE_URL=$CLAUDE_API_BASE_URL"
Environment="CODEX_RUNNER_CLAUDE_API_PATH=$CLAUDE_API_PATH"
Environment="CODEX_RUNNER_CLAUDE_API_KEY_FILE=$CLAUDE_API_KEY_FILE"
Environment="CODEX_RUNNER_CLAUDE_PLATFORM_CONFIG_DIR=$CLAUDE_PLATFORM_CONFIG_DIR"
Environment="CODEX_RUNNER_CLAUDE_PLATFORM_PROFILE=$CLAUDE_PLATFORM_PROFILE"
Environment=CODEX_RUNNER_MANAGED_EXECUTION=1
ExecStart=$BIN_PATH serve --role core --addr $CORE_ADDR --agentic-addr $AGENTIC_ADDR --state-dir $STATE_DIR --db $DB_PATH --codex-cmd $codex_cmd$(auth_token_file_systemd_args)
Restart=always
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=default.target
UNIT
  cat > "$agentic_unit" <<UNIT
[Unit]
Description=Xuanwu Agentic Worker
After=$SERVICE_NAME-core.service

[Service]
Type=simple
WorkingDirectory=$STATE_DIR
Environment=HOME=$HOME
Environment=PATH=$PATH_VALUE
Environment=PI_PACKAGE_DIR=$STATE_DIR/pi-coding-agent
Environment=CODEX_RUNNER_MANAGED_EXECUTION=1
ExecStart=$BIN_PATH serve --role agentic --addr $AGENTIC_ADDR --state-dir $STATE_DIR --db $DB_PATH$(auth_token_file_systemd_args)
Restart=always
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=default.target
UNIT
  cat > "$web_unit" <<UNIT
[Unit]
Description=Xuanwu Web Gateway
After=$SERVICE_NAME-core.service $SERVICE_NAME-agentic.service

[Service]
Type=simple
WorkingDirectory=$STATE_DIR
Environment=HOME=$HOME
Environment=PATH=$PATH_VALUE
ExecStart=$BIN_PATH serve --role web --addr $ADDR --core-addr $CORE_ADDR --web-dir $STATE_DIR/web
Restart=always
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user disable --now "$SERVICE_NAME.service" >/dev/null 2>&1 || true
  systemctl --user enable --now "$SERVICE_NAME-core.service" "$SERVICE_NAME-agentic.service" "$SERVICE_NAME-web.service"
  systemctl --user restart "$SERVICE_NAME-core.service" "$SERVICE_NAME-agentic.service" "$SERVICE_NAME-web.service"
  core_url="$(service_url "$CORE_ADDR")"
  web_url="$(service_url "$ADDR")"
  agentic_url="$(service_url "$AGENTIC_ADDR")"
  wait_until_ready "$core_url" || fail "Core did not become ready at $core_url"
  wait_until_ready "$agentic_url" || fail "Agentic Worker did not become ready at $agentic_url"
  wait_until_ready "$web_url" || fail "Web did not become ready at $web_url"
  log "systemd user services installed: $web_unit $core_unit $agentic_unit"
}

main() {
  if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
    usage
    exit 0
  fi
  require_cmd curl
  require_cmd tar
  require_cmd uname
  require_cmd awk
  if ! command -v sha256sum >/dev/null 2>&1; then require_cmd shasum; fi
  audit requested
  trap 'audit failed' ERR
  local os arch
  read -r os arch < <(detect_platform)
  download_binary "$os" "$arch"
  write_custom_auth_token_file
  write_claude_api_key_file
  case "$os" in
    darwin) install_macos_launchd ;;
    linux) install_linux_systemd ;;
  esac
  audit applied
  trap - ERR
  log "ready: $(service_url "$ADDR")/"
  log "data: $STATE_DIR"
}

main "$@"
