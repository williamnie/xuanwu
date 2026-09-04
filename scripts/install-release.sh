#!/usr/bin/env bash
set -euo pipefail

if [ "${XUANWU_MANAGED_EXECUTION:-}" = "1" ] ||
  { [ -n "${PI_PACKAGE_DIR:-}" ] && [ -n "${XUANWU_CODEX_SERVER_MODE:-}" ]; }; then
  echo "[deploy-guard] denied: live deployment cannot run from a Runner-managed provider process." >&2
  exit 78
fi

REPO="${XUANWU_REPO:-williamnie/xuanwu}"
VERSION="${XUANWU_VERSION:-latest}"
VERIFY_ATTESTATION="${XUANWU_VERIFY_ATTESTATION:-auto}"
ADDR="${XUANWU_ADDR:-0.0.0.0:3008}"
CORE_ADDR="${XUANWU_CORE_ADDR:-127.0.0.1:3009}"
AGENTIC_ADDR="${XUANWU_AGENTIC_ADDR:-127.0.0.1:3010}"
LABEL="${XUANWU_LAUNCHD_LABEL:-com.xiaobei.xuanwu}"
WEB_LABEL="${LABEL}.web"
CORE_LABEL="${LABEL}.core"
AGENTIC_LABEL="${LABEL}.agentic"
UPDATER_LABEL="${LABEL}.updater"
SERVICE_NAME="${XUANWU_SERVICE_NAME:-xuanwu}"
INSTALL_DIR="${XUANWU_INSTALL_DIR:-$HOME/.local/bin}"
STATE_DIR="${XUANWU_STATE_DIR:-$HOME/.local/state/xuanwu}"
LOG_DIR="${XUANWU_LOG_DIR:-$STATE_DIR/logs}"
BACKUP_DIR="${XUANWU_BACKUP_DIR:-$STATE_DIR-backups}"
DB_PATH="${XUANWU_DB:-${XUANWU_DEPLOY_DB:-$STATE_DIR/runner.db}}"
AUTH_TOKEN_FILE="${XUANWU_AUTH_TOKEN_FILE:-$STATE_DIR/auth_token}"
AUTH_TOKEN="${XUANWU_AUTH_TOKEN:-}"
AUTH_TOKEN_CREATED=0
BIN_PATH="$INSTALL_DIR/xuanwu"
CLAUDE_SDK_EXECUTABLE_PATH="$BIN_PATH.claude-agent-sdk"
QODERCLI_RUNTIME_PATH="$BIN_PATH.qodercli"
QODERCLI_EXECUTABLE_PATH="$QODERCLI_RUNTIME_PATH/qodercli.mjs"
PI_POLICY_EXTENSION_PATH="$BIN_PATH.pi-policy-extension.ts"
DAEMON_PATH="$INSTALL_DIR/xuanwu-daemon"
INSTALLER_PATH="$INSTALL_DIR/xuanwu-install"
UPDATER_PATH="$INSTALL_DIR/xuanwu-update"
PATH_VALUE="${XUANWU_PATH:-$PATH}"
CODEX_CMD="${XUANWU_CODEX_CMD:-}"
CODEX_SERVER_MODE="${XUANWU_CODEX_SERVER_MODE:-cli}"
CODEX_APP_CMD="${XUANWU_CODEX_APP_CMD:-}"
CLAUDE_MODE="${XUANWU_CLAUDE_MODE:-}"
CLAUDE_AUTH_MODE="${XUANWU_CLAUDE_AUTH_MODE:-}"
CLAUDE_API_BASE_URL="${XUANWU_CLAUDE_API_BASE_URL:-${ANTHROPIC_BASE_URL:-}}"
CLAUDE_API_PATH="${XUANWU_CLAUDE_API_PATH:-}"
CLAUDE_API_KEY="${XUANWU_CLAUDE_API_KEY:-${ANTHROPIC_API_KEY:-}}"
CLAUDE_API_KEY_FILE="${XUANWU_CLAUDE_API_KEY_FILE:-$STATE_DIR/claude_api_key}"
CLAUDE_PLATFORM_CONFIG_DIR="${XUANWU_CLAUDE_PLATFORM_CONFIG_DIR:-${ANTHROPIC_CONFIG_DIR:-}}"
CLAUDE_PLATFORM_PROFILE="${XUANWU_CLAUDE_PLATFORM_PROFILE:-${ANTHROPIC_PROFILE:-}}"
QODER_AUTH_MODE="${XUANWU_QODER_AUTH_MODE:-local-cli}"
QODER_CONFIG_DIR="${XUANWU_QODER_CONFIG_DIR:-}"
QODER_CREDENTIAL_REF="${XUANWU_QODER_CREDENTIAL_REF:-}"
QODER_MODEL="${XUANWU_QODER_MODEL:-}"
PI_CHAT_TOOL_SURFACE="${XUANWU_PI_CHAT_TOOL_SURFACE:-bootstrap_v2}"
AGENT_SKILL_TARGET="${XUANWU_AGENT_SKILL_TARGET:-codex}"
if [ -z "$CLAUDE_MODE" ]; then
  CLAUDE_MODE="sdk"
fi
if [ -z "$CLAUDE_AUTH_MODE" ]; then
  if [ -n "$CLAUDE_PLATFORM_CONFIG_DIR" ] || [ -n "$CLAUDE_PLATFORM_PROFILE" ]; then
    CLAUDE_AUTH_MODE="platform-profile"
  elif [ -z "$CLAUDE_API_KEY" ] && [ ! -s "$CLAUDE_API_KEY_FILE" ]; then
    CLAUDE_AUTH_MODE="local-cli"
  else
    CLAUDE_AUTH_MODE="environment"
  fi
fi
AUDIT_LOG="$LOG_DIR/release-upgrade.log"
RESOLVED_VERSION=""

usage() {
  cat <<'HELP'
Install and run Xuanwu.

Usage:
  curl -fsSL https://raw.githubusercontent.com/williamnie/xuanwu/main/scripts/install-release.sh | bash

Useful environment variables:
  XUANWU_VERSION=v0.1.0          Install a fixed release tag instead of latest
  XUANWU_ADDR=0.0.0.0:3008       Service listen address
  XUANWU_CORE_ADDR=127.0.0.1:3009 Internal Core listen address
  XUANWU_AGENTIC_ADDR=127.0.0.1:3010 Internal Agentic Worker listen address
  XUANWU_INSTALL_DIR=~/.local/bin Binary install directory
  XUANWU_STATE_DIR=~/.local/state/xuanwu
  XUANWU_CODEX_CMD=/path/to/codex Codex CLI path
  XUANWU_CODEX_SERVER_MODE=cli|app Codex server backend
  XUANWU_CODEX_APP_CMD=/path/to/app/codex Codex App bundled server command
  XUANWU_CLAUDE_MODE=sdk|cli-fallback Claude provider mode
  XUANWU_CLAUDE_AUTH_MODE=environment|local-cli|platform-profile
  XUANWU_CLAUDE_API_BASE_URL=https://... Claude/Anthropic API base URL
  XUANWU_CLAUDE_API_PATH=/... Optional path appended to the API base URL
  XUANWU_CLAUDE_API_KEY=...     Claude API key (persisted to a mode-0600 state file)
  XUANWU_CLAUDE_PLATFORM_CONFIG_DIR=... Anthropic profile config directory
  XUANWU_CLAUDE_PLATFORM_PROFILE=... Anthropic profile name
  XUANWU_QODER_AUTH_MODE=local-cli|pat-env|pat-secret-ref|service-account-secret-ref
  XUANWU_QODER_CONFIG_DIR=...     Qoder CLI config directory
  XUANWU_QODER_CREDENTIAL_REF=secret://...|env://... Qoder credential locator
  XUANWU_PI_CHAT_TOOL_SURFACE=bootstrap_v2|legacy_full PI chat tool-surface rollback selector
  XUANWU_AGENT_SKILL_TARGET=codex|claude|all|none Install the bundled agent Skill (default: codex)
  XUANWU_CODEX_SKILLS_DIR=...   Override the Codex Skills directory
  XUANWU_CLAUDE_SKILLS_DIR=...  Override the Claude Code Skills directory
  XUANWU_AUTH_TOKEN=...          Custom bearer token for remote access
  XUANWU_AUTH_TOKEN_FILE=...     Generated token file path
  XUANWU_VERIFY_ATTESTATION=auto|require|skip

After installation, use `xuanwu-daemon status|doctor|restart|uninstall`
and `xuanwu-update check|upgrade|rollback`.
`uninstall` keeps the state directory and database.
HELP
}

log() { printf '[install] %s\n' "$*"; }
fail() { printf '[install] ERROR: %s\n' "$*" >&2; exit 1; }

case "$CLAUDE_AUTH_MODE" in
  environment) ;;
  local-cli) ;;
  platform-profile) [ "$CLAUDE_MODE" = "sdk" ] || fail "XUANWU_CLAUDE_AUTH_MODE=platform-profile requires sdk mode" ;;
  *) fail "XUANWU_CLAUDE_AUTH_MODE must be environment, local-cli, or platform-profile" ;;
esac
case "$QODER_AUTH_MODE" in
  local-cli|pat-env) ;;
  pat-secret-ref|service-account-secret-ref)
    [ -n "$QODER_CREDENTIAL_REF" ] || fail "XUANWU_QODER_CREDENTIAL_REF is required for $QODER_AUTH_MODE"
    ;;
  *) fail "XUANWU_QODER_AUTH_MODE must be local-cli, pat-env, pat-secret-ref, or service-account-secret-ref" ;;
esac
case "$PI_CHAT_TOOL_SURFACE" in
  bootstrap_v2|legacy_full) ;;
  *) fail "XUANWU_PI_CHAT_TOOL_SURFACE must be bootstrap_v2 or legacy_full" ;;
esac
case "$AGENT_SKILL_TARGET" in
  codex|claude|all|none) ;;
  *) fail "XUANWU_AGENT_SKILL_TARGET must be codex, claude, all, or none" ;;
esac
if [ -n "$CLAUDE_PLATFORM_PROFILE" ] && [[ ! "$CLAUDE_PLATFORM_PROFILE" =~ ^[A-Za-z0-9_.-]+$ || "$CLAUDE_PLATFORM_PROFILE" = "." || "$CLAUDE_PLATFORM_PROFILE" = ".." ]]; then
  fail "XUANWU_CLAUDE_PLATFORM_PROFILE is invalid"
fi

audit() {
  local outcome="$1"
  mkdir -p "$LOG_DIR"
  chmod 700 "$LOG_DIR" 2>/dev/null || true
  printf '%s action=install outcome=%s version=%s actor=%q actor_kind=%q audit_ref=%q reason=%q\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$outcome" "${RESOLVED_VERSION:-$VERSION}" \
    "${XUANWU_AUDIT_ACTOR:-${USER:-unknown}}" "${XUANWU_AUDIT_ACTOR_KIND:-user}" \
    "${XUANWU_AUDIT_REF:-shell:install-release}" "${XUANWU_AUDIT_REASON:-manual install}" >> "$AUDIT_LOG"
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
    *) fail "XUANWU_VERIFY_ATTESTATION must be auto, require, or skip" ;;
  esac
  if ! command -v gh >/dev/null 2>&1; then
    [ "$VERIFY_ATTESTATION" = "require" ] && fail "gh is required for release attestation verification"
    log "warning: gh not found; SHA-256 verified but signed provenance was not checked"
    return 0
  fi
  if ! gh attestation verify "$archive" --repo "$REPO" \
    --signer-workflow "$REPO/.github/workflows/release.yml" >/dev/null; then
    [ "$VERIFY_ATTESTATION" = "require" ] && fail "GitHub artifact attestation verification failed"
    log "warning: SHA-256 verified but signed GitHub provenance is unavailable"
    return 0
  fi
  log "verified signed GitHub provenance"
}

release_version() {
  sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -n 1
}

release_qoder_cli_version() {
  local version
  # 旧发布包未声明该字段，保留当时冻结的 CLI 配对；新包必须精确校验自己的版本。
  if ! grep -q '"qoder_cli_version"[[:space:]]*:' "$1"; then
    printf '1.1.23'
    return
  fi
  version="$(sed -n 's/^[[:space:]]*"qoder_cli_version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -n 1)"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "release metadata contains invalid qoder_cli_version"
  printf '%s' "$version"
}

resolve_codex_cmd() {
  if [ -n "$CODEX_CMD" ]; then
    printf '%s' "$CODEX_CMD"
    return
  fi
  if ! command -v codex >/dev/null 2>&1; then
    fail "codex command not found; set XUANWU_CODEX_CMD=/absolute/path/to/codex"
  fi
  command -v codex
}

install_bundled_agent_skill() {
  local package_dir="$1" installer
  installer="$package_dir/scripts/install-agent-skill.sh"
  [ "$AGENT_SKILL_TARGET" != "none" ] || {
    log "skipped bundled agent Skill installation"
    return 0
  }
  if [ ! -f "$package_dir/skills/xuanwu/SKILL.md" ] || [ ! -f "$installer" ]; then
    log "warning: release $RESOLVED_VERSION does not include the bundled Xuanwu agent Skill; continuing for compatibility"
    return 0
  fi
  bash "$installer" "$AGENT_SKILL_TARGET"
}

download_binary() {
  local os="$1" arch="$2" asset url tmp archive checksums metadata staged sdk_staged qoder_staged qoder_previous pi_policy_staged daemon_staged installer_staged updater_staged binary_version qoder_version expected_qoder_version
  asset="xuanwu_${os}_${arch}.tar.gz"
  url="$(release_asset_url "$asset")"
  tmp="$(mktemp -d)"
  archive="$tmp/xuanwu.tar.gz"
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
  [ -x "$tmp/xuanwu" ] || fail "release asset does not contain executable binary"
  [ -x "$tmp/xuanwu.claude-agent-sdk" ] \
    || fail "release asset does not contain Claude Agent SDK native executable"
  [ -x "$tmp/xuanwu.qodercli/qodercli.mjs" ] \
    || fail "release asset does not contain exact-pinned Qoder CLI executable"
  [ -f "$tmp/xuanwu.qodercli/policies/sandbox-default.toml" ] \
    || fail "release asset does not contain Qoder CLI runtime policies"
  [ -f "$tmp/xuanwu.pi-policy-extension.ts" ] \
    || fail "release asset does not contain Pi policy extension"
  binary_version="$("$tmp/xuanwu" --version | awk 'NR == 1 { print $2 }')"
  [ "$binary_version" = "$RESOLVED_VERSION" ] \
    || fail "binary version $binary_version does not match release metadata $RESOLVED_VERSION"
  qoder_version="$("$tmp/xuanwu.qodercli/qodercli.mjs" --version | awk 'NR == 1 { print $1 }')"
  expected_qoder_version="$(release_qoder_cli_version "$metadata")"
  [ "$qoder_version" = "$expected_qoder_version" ] \
    || fail "Qoder CLI version $qoder_version does not match required $expected_qoder_version"
  install_bundled_agent_skill "$tmp"
  mkdir -p "$INSTALL_DIR" "$STATE_DIR" "$LOG_DIR" "$(dirname "$AUTH_TOKEN_FILE")"
  sdk_staged="$INSTALL_DIR/.xuanwu.claude-agent-sdk.stage.$$"
  install -m 0755 "$tmp/xuanwu.claude-agent-sdk" "$sdk_staged"
  mv -f "$sdk_staged" "$CLAUDE_SDK_EXECUTABLE_PATH"
  qoder_staged="$INSTALL_DIR/.xuanwu.qodercli.stage.$$"
  qoder_previous="$INSTALL_DIR/.xuanwu.qodercli.previous.$$"
  rm -rf "$qoder_staged" "$qoder_previous"
  cp -R "$tmp/xuanwu.qodercli" "$qoder_staged"
  if [ -e "$QODERCLI_RUNTIME_PATH" ]; then mv "$QODERCLI_RUNTIME_PATH" "$qoder_previous"; fi
  if ! mv "$qoder_staged" "$QODERCLI_RUNTIME_PATH"; then
    [ -e "$qoder_previous" ] && mv "$qoder_previous" "$QODERCLI_RUNTIME_PATH"
    fail "could not install Qoder CLI runtime"
  fi
  [ -e "$qoder_previous" ] && rm -rf "$qoder_previous"
  pi_policy_staged="$INSTALL_DIR/.xuanwu.pi-policy-extension.ts.stage.$$"
  install -m 0644 "$tmp/xuanwu.pi-policy-extension.ts" "$pi_policy_staged"
  mv -f "$pi_policy_staged" "$PI_POLICY_EXTENSION_PATH"
  staged="$INSTALL_DIR/.xuanwu.stage.$$"
  install -m 0755 "$tmp/xuanwu" "$staged"
  mv -f "$staged" "$BIN_PATH"
  if [ -f "$tmp/daemon.sh" ]; then
    daemon_staged="$INSTALL_DIR/.xuanwu-daemon.stage.$$"
    install -m 0755 "$tmp/daemon.sh" "$daemon_staged"
    mv -f "$daemon_staged" "$DAEMON_PATH"
  fi
  if [ -f "$tmp/install-release.sh" ]; then
    installer_staged="$INSTALL_DIR/.xuanwu-install.stage.$$"
    install -m 0755 "$tmp/install-release.sh" "$installer_staged"
    mv -f "$installer_staged" "$INSTALLER_PATH"
  fi
  if [ -f "$tmp/update-release.sh" ]; then
    updater_staged="$INSTALL_DIR/.xuanwu-update.stage.$$"
    install -m 0755 "$tmp/update-release.sh" "$updater_staged"
    mv -f "$updater_staged" "$UPDATER_PATH"
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
  local web_plist="$1" core_plist="$2" agentic_plist="$3" updater_plist="$4" codex_cmd="$5"
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
    <key>XUANWU_CODEX_SERVER_MODE</key>
    <string>$(xml_escape "$CODEX_SERVER_MODE")</string>
    <key>XUANWU_CODEX_APP_CMD</key>
    <string>$(xml_escape "$CODEX_APP_CMD")</string>
    <key>XUANWU_CLAUDE_MODE</key>
    <string>$(xml_escape "$CLAUDE_MODE")</string>
    <key>XUANWU_CLAUDE_AUTH_MODE</key>
    <string>$(xml_escape "$CLAUDE_AUTH_MODE")</string>
    <key>XUANWU_CLAUDE_API_BASE_URL</key>
    <string>$(xml_escape "$CLAUDE_API_BASE_URL")</string>
    <key>XUANWU_CLAUDE_API_PATH</key>
    <string>$(xml_escape "$CLAUDE_API_PATH")</string>
    <key>XUANWU_CLAUDE_API_KEY_FILE</key>
    <string>$(xml_escape "$CLAUDE_API_KEY_FILE")</string>
    <key>XUANWU_CLAUDE_PLATFORM_CONFIG_DIR</key>
    <string>$(xml_escape "$CLAUDE_PLATFORM_CONFIG_DIR")</string>
    <key>XUANWU_CLAUDE_PLATFORM_PROFILE</key>
    <string>$(xml_escape "$CLAUDE_PLATFORM_PROFILE")</string>
    <key>XUANWU_QODER_CMD</key>
    <string>$(xml_escape "$QODERCLI_EXECUTABLE_PATH")</string>
    <key>XUANWU_QODER_AUTH_MODE</key>
    <string>$(xml_escape "$QODER_AUTH_MODE")</string>
    <key>XUANWU_QODER_CONFIG_DIR</key>
    <string>$(xml_escape "$QODER_CONFIG_DIR")</string>
    <key>XUANWU_QODER_CREDENTIAL_REF</key>
    <string>$(xml_escape "$QODER_CREDENTIAL_REF")</string>
    <key>XUANWU_QODER_MODEL</key>
    <string>$(xml_escape "$QODER_MODEL")</string>
    <key>XUANWU_PI_CHAT_TOOL_SURFACE</key>
    <string>$(xml_escape "$PI_CHAT_TOOL_SURFACE")</string>
    <key>XUANWU_RELEASE_INSTALL</key>
    <string>1</string>
    <key>XUANWU_REPO</key>
    <string>$(xml_escape "$REPO")</string>
    <key>XUANWU_INSTALL_DIR</key>
    <string>$(xml_escape "$INSTALL_DIR")</string>
    <key>XUANWU_UPDATER_PATH</key>
    <string>$(xml_escape "$UPDATER_PATH")</string>
    <key>XUANWU_LAUNCHD_LABEL</key>
    <string>$(xml_escape "$LABEL")</string>
    <key>XUANWU_SERVICE_NAME</key>
    <string>$(xml_escape "$SERVICE_NAME")</string>
    <key>XUANWU_MANAGED_EXECUTION</key>
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
    <key>XUANWU_MANAGED_EXECUTION</key>
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

  cat > "$updater_plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$UPDATER_LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$UPDATER_PATH")</string>
    <string>apply-pending</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$(xml_escape "$HOME")</string>
    <key>PATH</key><string>$(xml_escape "$PATH_VALUE")</string>
    <key>XUANWU_REPO</key><string>$(xml_escape "$REPO")</string>
    <key>XUANWU_VERIFY_ATTESTATION</key><string>$(xml_escape "$VERIFY_ATTESTATION")</string>
    <key>XUANWU_ADDR</key><string>$(xml_escape "$ADDR")</string>
    <key>XUANWU_CORE_ADDR</key><string>$(xml_escape "$CORE_ADDR")</string>
    <key>XUANWU_AGENTIC_ADDR</key><string>$(xml_escape "$AGENTIC_ADDR")</string>
    <key>XUANWU_LAUNCHD_LABEL</key><string>$(xml_escape "$LABEL")</string>
    <key>XUANWU_SERVICE_NAME</key><string>$(xml_escape "$SERVICE_NAME")</string>
    <key>XUANWU_INSTALL_DIR</key><string>$(xml_escape "$INSTALL_DIR")</string>
    <key>XUANWU_STATE_DIR</key><string>$(xml_escape "$STATE_DIR")</string>
    <key>XUANWU_LOG_DIR</key><string>$(xml_escape "$LOG_DIR")</string>
    <key>XUANWU_BACKUP_DIR</key><string>$(xml_escape "$BACKUP_DIR")</string>
    <key>XUANWU_DB</key><string>$(xml_escape "$DB_PATH")</string>
    <key>XUANWU_AUTH_TOKEN_FILE</key><string>$(xml_escape "$AUTH_TOKEN_FILE")</string>
    <key>XUANWU_PATH</key><string>$(xml_escape "$PATH_VALUE")</string>
    <key>XUANWU_CODEX_CMD</key><string>$(xml_escape "$codex_cmd")</string>
    <key>XUANWU_CODEX_SERVER_MODE</key><string>$(xml_escape "$CODEX_SERVER_MODE")</string>
    <key>XUANWU_CODEX_APP_CMD</key><string>$(xml_escape "$CODEX_APP_CMD")</string>
    <key>XUANWU_CLAUDE_MODE</key><string>$(xml_escape "$CLAUDE_MODE")</string>
    <key>XUANWU_CLAUDE_AUTH_MODE</key><string>$(xml_escape "$CLAUDE_AUTH_MODE")</string>
    <key>XUANWU_CLAUDE_API_BASE_URL</key><string>$(xml_escape "$CLAUDE_API_BASE_URL")</string>
    <key>XUANWU_CLAUDE_API_PATH</key><string>$(xml_escape "$CLAUDE_API_PATH")</string>
    <key>XUANWU_CLAUDE_API_KEY_FILE</key><string>$(xml_escape "$CLAUDE_API_KEY_FILE")</string>
    <key>XUANWU_CLAUDE_PLATFORM_CONFIG_DIR</key><string>$(xml_escape "$CLAUDE_PLATFORM_CONFIG_DIR")</string>
    <key>XUANWU_CLAUDE_PLATFORM_PROFILE</key><string>$(xml_escape "$CLAUDE_PLATFORM_PROFILE")</string>
    <key>XUANWU_QODER_AUTH_MODE</key><string>$(xml_escape "$QODER_AUTH_MODE")</string>
    <key>XUANWU_QODER_CONFIG_DIR</key><string>$(xml_escape "$QODER_CONFIG_DIR")</string>
    <key>XUANWU_QODER_CREDENTIAL_REF</key><string>$(xml_escape "$QODER_CREDENTIAL_REF")</string>
    <key>XUANWU_QODER_MODEL</key><string>$(xml_escape "$QODER_MODEL")</string>
    <key>XUANWU_PI_CHAT_TOOL_SURFACE</key><string>$(xml_escape "$PI_CHAT_TOOL_SURFACE")</string>
    <key>XUANWU_RELEASE_INSTALL</key><string>1</string>
    <key>XUANWU_UPDATER_PATH</key><string>$(xml_escape "$UPDATER_PATH")</string>
    <key>XUANWU_UPDATER_ACTIVE</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><false/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$(xml_escape "$LOG_DIR/launchd.updater.out.log")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$LOG_DIR/launchd.updater.err.log")</string>
</dict>
</plist>
PLIST
}

auth_token_file_systemd_args() {
  if [ -n "$AUTH_TOKEN_FILE" ]; then
    printf ' --auth-token-file %q' "$AUTH_TOKEN_FILE"
  fi
}

generate_auth_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32 | tr -d '\n'
    return
  fi
  if [ -r /dev/urandom ] && command -v od >/dev/null 2>&1; then
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
    return
  fi
  fail "cannot generate remote access token: install openssl or provide XUANWU_AUTH_TOKEN"
}

ensure_auth_token_file() {
  mkdir -p "$(dirname "$AUTH_TOKEN_FILE")"
  umask 077
  if [ -n "$AUTH_TOKEN" ]; then
    printf '%s\n' "$AUTH_TOKEN" > "$AUTH_TOKEN_FILE"
  elif [ ! -s "$AUTH_TOKEN_FILE" ]; then
    generate_auth_token > "$AUTH_TOKEN_FILE"
    printf '\n' >> "$AUTH_TOKEN_FILE"
    AUTH_TOKEN_CREATED=1
  fi
  chmod 600 "$AUTH_TOKEN_FILE"
}

print_auth_token_guidance() {
  log "remote access token file: $AUTH_TOKEN_FILE"
  if [ "$AUTH_TOKEN_CREATED" = "1" ] && [ -t 1 ]; then
    printf '[install] remote access token (shown once): %s\n' "$(tr -d '\n' < "$AUTH_TOKEN_FILE")"
  elif [ "$AUTH_TOKEN_CREATED" = "1" ]; then
    log "remote access token generated; value hidden because output is not an interactive terminal"
  else
    log "existing or explicitly configured remote access token preserved"
  fi
  printf '[install] read later: cat %q\n' "$AUTH_TOKEN_FILE"
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
  local codex_cmd web_plist core_plist agentic_plist updater_plist legacy_plist domain web_url core_url agentic_url
  codex_cmd="$(resolve_codex_cmd)"
  web_plist="$HOME/Library/LaunchAgents/$WEB_LABEL.plist"
  core_plist="$HOME/Library/LaunchAgents/$CORE_LABEL.plist"
  agentic_plist="$HOME/Library/LaunchAgents/$AGENTIC_LABEL.plist"
  updater_plist="$HOME/Library/LaunchAgents/$UPDATER_LABEL.plist"
  legacy_plist="$HOME/Library/LaunchAgents/$LABEL.plist"
  domain="gui/$(id -u)"
  mkdir -p "$HOME/Library/LaunchAgents"
  write_macos_plists "$web_plist" "$core_plist" "$agentic_plist" "$updater_plist" "$codex_cmd"
  plutil -lint "$web_plist" >/dev/null
  plutil -lint "$core_plist" >/dev/null
  plutil -lint "$agentic_plist" >/dev/null
  plutil -lint "$updater_plist" >/dev/null
  launchctl enable "$domain/$UPDATER_LABEL" >/dev/null 2>&1 || true
  if [ "${XUANWU_UPDATER_ACTIVE:-}" != "1" ]; then
    launchctl bootout "$domain/$UPDATER_LABEL" >/dev/null 2>&1 || true
    launchctl bootstrap "$domain" "$updater_plist"
  elif ! launchctl print "$domain/$UPDATER_LABEL" >/dev/null 2>&1; then
    launchctl bootstrap "$domain" "$updater_plist"
  fi
  launchctl bootout "$domain/$LABEL" >/dev/null 2>&1 || launchctl bootout "$domain" "$legacy_plist" >/dev/null 2>&1 || true
  launchctl bootout "$domain/$WEB_LABEL" >/dev/null 2>&1 || true
  launchctl bootout "$domain/$CORE_LABEL" >/dev/null 2>&1 || true
  launchctl bootout "$domain/$AGENTIC_LABEL" >/dev/null 2>&1 || true
  launchctl enable "$domain/$CORE_LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "$domain" "$core_plist"
  launchctl kickstart -k "$domain/$CORE_LABEL"
  core_url="$(service_url "$CORE_ADDR")"
  wait_until_ready "$core_url" || fail "Core did not become ready at $core_url"
  launchctl enable "$domain/$AGENTIC_LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "$domain" "$agentic_plist"
  launchctl kickstart -k "$domain/$AGENTIC_LABEL"
  agentic_url="$(service_url "$AGENTIC_ADDR")"
  wait_until_ready "$agentic_url" || fail "Agentic Worker did not become ready at $agentic_url"
  launchctl enable "$domain/$WEB_LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "$domain" "$web_plist"
  launchctl kickstart -k "$domain/$WEB_LABEL"
  web_url="$(service_url "$ADDR")"
  wait_until_ready "$web_url" || fail "Web did not become ready at $web_url"
  log "launchd services installed: $web_plist $core_plist $agentic_plist $updater_plist"
}

install_linux_systemd() {
  local codex_cmd unit_dir web_unit core_unit agentic_unit updater_unit web_url core_url agentic_url
  require_cmd systemctl
  require_cmd loginctl
  loginctl enable-linger "$USER" || fail "failed to enable user linger; systemd user service would stop after logout"
  codex_cmd="$(resolve_codex_cmd)"
  unit_dir="$HOME/.config/systemd/user"
  web_unit="$unit_dir/$SERVICE_NAME-web.service"
  core_unit="$unit_dir/$SERVICE_NAME-core.service"
  agentic_unit="$unit_dir/$SERVICE_NAME-agentic.service"
  updater_unit="$unit_dir/$SERVICE_NAME-updater.service"
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
Environment="XUANWU_CODEX_SERVER_MODE=$CODEX_SERVER_MODE"
Environment="XUANWU_CODEX_APP_CMD=$CODEX_APP_CMD"
Environment="XUANWU_CLAUDE_MODE=$CLAUDE_MODE"
Environment="XUANWU_CLAUDE_AUTH_MODE=$CLAUDE_AUTH_MODE"
Environment="XUANWU_CLAUDE_API_BASE_URL=$CLAUDE_API_BASE_URL"
Environment="XUANWU_CLAUDE_API_PATH=$CLAUDE_API_PATH"
Environment="XUANWU_CLAUDE_API_KEY_FILE=$CLAUDE_API_KEY_FILE"
Environment="XUANWU_CLAUDE_PLATFORM_CONFIG_DIR=$CLAUDE_PLATFORM_CONFIG_DIR"
Environment="XUANWU_CLAUDE_PLATFORM_PROFILE=$CLAUDE_PLATFORM_PROFILE"
Environment="XUANWU_QODER_CMD=$QODERCLI_EXECUTABLE_PATH"
Environment="XUANWU_QODER_AUTH_MODE=$QODER_AUTH_MODE"
Environment="XUANWU_QODER_CONFIG_DIR=$QODER_CONFIG_DIR"
Environment="XUANWU_QODER_CREDENTIAL_REF=$QODER_CREDENTIAL_REF"
Environment="XUANWU_QODER_MODEL=$QODER_MODEL"
Environment="XUANWU_PI_CHAT_TOOL_SURFACE=$PI_CHAT_TOOL_SURFACE"
Environment=XUANWU_RELEASE_INSTALL=1
Environment="XUANWU_REPO=$REPO"
Environment="XUANWU_INSTALL_DIR=$INSTALL_DIR"
Environment="XUANWU_UPDATER_PATH=$UPDATER_PATH"
Environment="XUANWU_SERVICE_NAME=$SERVICE_NAME"
Environment=XUANWU_MANAGED_EXECUTION=1
ExecStart=$BIN_PATH serve --role core --addr $CORE_ADDR --agentic-addr $AGENTIC_ADDR --state-dir $STATE_DIR --db $DB_PATH --codex-cmd $codex_cmd$(auth_token_file_systemd_args)
Restart=always
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=default.target
UNIT
  cat > "$updater_unit" <<UNIT
[Unit]
Description=Xuanwu Release Updater
After=network.target

[Service]
Type=oneshot
WorkingDirectory=$STATE_DIR
Environment=HOME=$HOME
Environment="PATH=$PATH_VALUE"
Environment="XUANWU_REPO=$REPO"
Environment="XUANWU_VERIFY_ATTESTATION=$VERIFY_ATTESTATION"
Environment="XUANWU_ADDR=$ADDR"
Environment="XUANWU_CORE_ADDR=$CORE_ADDR"
Environment="XUANWU_AGENTIC_ADDR=$AGENTIC_ADDR"
Environment="XUANWU_SERVICE_NAME=$SERVICE_NAME"
Environment="XUANWU_INSTALL_DIR=$INSTALL_DIR"
Environment="XUANWU_STATE_DIR=$STATE_DIR"
Environment="XUANWU_LOG_DIR=$LOG_DIR"
Environment="XUANWU_BACKUP_DIR=$BACKUP_DIR"
Environment="XUANWU_DB=$DB_PATH"
Environment="XUANWU_AUTH_TOKEN_FILE=$AUTH_TOKEN_FILE"
Environment="XUANWU_PATH=$PATH_VALUE"
Environment="XUANWU_CODEX_CMD=$codex_cmd"
Environment="XUANWU_CODEX_SERVER_MODE=$CODEX_SERVER_MODE"
Environment="XUANWU_CODEX_APP_CMD=$CODEX_APP_CMD"
Environment="XUANWU_CLAUDE_MODE=$CLAUDE_MODE"
Environment="XUANWU_CLAUDE_AUTH_MODE=$CLAUDE_AUTH_MODE"
Environment="XUANWU_CLAUDE_API_BASE_URL=$CLAUDE_API_BASE_URL"
Environment="XUANWU_CLAUDE_API_PATH=$CLAUDE_API_PATH"
Environment="XUANWU_CLAUDE_API_KEY_FILE=$CLAUDE_API_KEY_FILE"
Environment="XUANWU_CLAUDE_PLATFORM_CONFIG_DIR=$CLAUDE_PLATFORM_CONFIG_DIR"
Environment="XUANWU_CLAUDE_PLATFORM_PROFILE=$CLAUDE_PLATFORM_PROFILE"
Environment="XUANWU_QODER_AUTH_MODE=$QODER_AUTH_MODE"
Environment="XUANWU_QODER_CONFIG_DIR=$QODER_CONFIG_DIR"
Environment="XUANWU_QODER_CREDENTIAL_REF=$QODER_CREDENTIAL_REF"
Environment="XUANWU_QODER_MODEL=$QODER_MODEL"
Environment="XUANWU_PI_CHAT_TOOL_SURFACE=$PI_CHAT_TOOL_SURFACE"
Environment=XUANWU_RELEASE_INSTALL=1
Environment="XUANWU_UPDATER_PATH=$UPDATER_PATH"
Environment=XUANWU_UPDATER_ACTIVE=1
ExecStart=$UPDATER_PATH apply-pending
TimeoutStartSec=1800
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
Environment=XUANWU_MANAGED_EXECUTION=1
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
  log "systemd user services installed: $web_unit $core_unit $agentic_unit $updater_unit"
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
  require_cmd node
  if ! command -v sha256sum >/dev/null 2>&1; then require_cmd shasum; fi
  audit requested
  trap 'audit failed' ERR
  local os arch
  read -r os arch < <(detect_platform)
  download_binary "$os" "$arch"
  ensure_auth_token_file
  write_claude_api_key_file
  case "$os" in
    darwin) install_macos_launchd ;;
    linux) install_linux_systemd ;;
  esac
  audit applied
  trap - ERR
  log "ready: $(service_url "$ADDR")/"
  log "data: $STATE_DIR"
  print_auth_token_guidance
}

main "$@"
