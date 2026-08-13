#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/assert-external-deploy-context.sh"
LABEL="${XUANWU_LAUNCHD_LABEL:-com.xiaobei.xuanwu}"
ADDR="${XUANWU_ADDR:-0.0.0.0:3008}"
CORE_ADDR="${XUANWU_CORE_ADDR:-127.0.0.1:3009}"
AGENTIC_ADDR="${XUANWU_AGENTIC_ADDR:-127.0.0.1:3010}"
WEB_LABEL="${LABEL}.web"
CORE_LABEL="${LABEL}.core"
AGENTIC_LABEL="${LABEL}.agentic"
APP_SUPPORT_DIR="${XUANWU_APP_SUPPORT_DIR:-$HOME/Library/Application Support/xuanwu-bun-live}"
STATE_DIR="${XUANWU_STATE_DIR:-$APP_SUPPORT_DIR/state}"
DB_PATH="${XUANWU_DB:-${XUANWU_DEPLOY_DB:-$STATE_DIR/runner.db}}"
AUTH_TOKEN_FILE="${XUANWU_AUTH_TOKEN_FILE:-$STATE_DIR/auth_token}"
AUTH_TOKEN="${XUANWU_AUTH_TOKEN:-}"
AUTH_TOKEN_CREATED=0
SOURCE_WEB_DIR="${XUANWU_SOURCE_WEB_DIR:-$ROOT_DIR/frontend/dist}"
WEB_DIR="${XUANWU_WEB_DIR:-$STATE_DIR/web}"
BINARY_PATH="${XUANWU_BINARY:-$ROOT_DIR/dist/xuanwu}"
LAUNCHD_BINARY_PATH="${XUANWU_LAUNCHD_BINARY:-$APP_SUPPORT_DIR/bin/xuanwu}"
CLAUDE_SDK_EXECUTABLE_SOURCE="$BINARY_PATH.claude-agent-sdk"
CLAUDE_SDK_EXECUTABLE_PATH="$LAUNCHD_BINARY_PATH.claude-agent-sdk"
QODERCLI_RUNTIME_SOURCE="$BINARY_PATH.qodercli"
QODERCLI_RUNTIME_PATH="$LAUNCHD_BINARY_PATH.qodercli"
QODERCLI_EXECUTABLE_SOURCE="$QODERCLI_RUNTIME_SOURCE/qodercli.mjs"
QODERCLI_EXECUTABLE_PATH="$QODERCLI_RUNTIME_PATH/qodercli.mjs"
LEGACY_QODERCLI_EXECUTABLE_PATH="$LAUNCHD_BINARY_PATH.qodercli.mjs"
PI_POLICY_EXTENSION_SOURCE="$BINARY_PATH.pi-policy-extension.ts"
PI_POLICY_EXTENSION_PATH="$LAUNCHD_BINARY_PATH.pi-policy-extension.ts"
PI_PACKAGE_ASSET_SOURCE="${XUANWU_PI_PACKAGE_ASSET_SOURCE:-$ROOT_DIR/backend-ts/node_modules/@earendil-works/pi-coding-agent}"
PI_PACKAGE_ASSET_DIR="${XUANWU_PI_PACKAGE_ASSET_DIR:-$APP_SUPPORT_DIR/pi-coding-agent}"
RUNNER_SKILLS_SOURCE="${XUANWU_SKILLS_SOURCE:-$ROOT_DIR/skills}"
RUNNER_PLUGINS_SOURCE="${XUANWU_PLUGINS_SOURCE:-$ROOT_DIR/plugins}"
PHOTON_WASM_SOURCE="${XUANWU_PHOTON_WASM_SOURCE:-$ROOT_DIR/backend-ts/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm}"
LOG_DIR="${XUANWU_LOG_DIR:-$APP_SUPPORT_DIR/logs}"
CODEX_CMD="${XUANWU_CODEX_CMD:-$(command -v codex || true)}"
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
if [ -z "$CLAUDE_MODE" ]; then
  if [ -n "$CLAUDE_API_KEY" ] || [ -s "$CLAUDE_API_KEY_FILE" ] || [ "$CLAUDE_AUTH_MODE" = "environment" ] || [ "$CLAUDE_AUTH_MODE" = "platform-profile" ] || [ -n "$CLAUDE_PLATFORM_CONFIG_DIR" ] || [ -n "$CLAUDE_PLATFORM_PROFILE" ]; then
    CLAUDE_MODE="sdk"
  else
    CLAUDE_MODE="cli-fallback"
  fi
fi
if [ -z "$CLAUDE_AUTH_MODE" ]; then
  if [ "$CLAUDE_MODE" = "cli-fallback" ] && [ -z "$CLAUDE_API_KEY" ]; then
    CLAUDE_AUTH_MODE="local-cli"
  else
    CLAUDE_AUTH_MODE="environment"
  fi
fi
AUTOMATION_SHADOW_W1="${XUANWU_AUTOMATION_SHADOW_W1:-0}"
SKIP_RUNTIME_BACKUP="${XUANWU_SKIP_RUNTIME_BACKUP:-0}"
PATH_VALUE="${XUANWU_PATH:-$PATH}"
LEGACY_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
WEB_PLIST="$HOME/Library/LaunchAgents/$WEB_LABEL.plist"
CORE_PLIST="$HOME/Library/LaunchAgents/$CORE_LABEL.plist"
AGENTIC_PLIST="$HOME/Library/LaunchAgents/$AGENTIC_LABEL.plist"
DOMAIN="gui/$(id -u)"

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
  elif [[ "$addr" == :* ]]; then
    printf 'http://127.0.0.1%s' "$addr"
  else
    printf 'http://%s' "$addr"
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
  echo "[launchd] cannot generate remote access token: install openssl or provide XUANWU_AUTH_TOKEN" >&2
  return 1
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
  echo "[launchd] remote access token file: $AUTH_TOKEN_FILE"
  if [ "$AUTH_TOKEN_CREATED" = "1" ] && [ -t 1 ]; then
    printf '[launchd] remote access token (shown once): %s\n' "$(tr -d '\n' < "$AUTH_TOKEN_FILE")"
  elif [ "$AUTH_TOKEN_CREATED" = "1" ]; then
    echo "[launchd] remote access token generated; value hidden because output is not an interactive terminal"
  else
    echo "[launchd] existing or explicitly configured remote access token preserved"
  fi
  printf '[launchd] read later: cat %q\n' "$AUTH_TOKEN_FILE"
}

write_claude_api_key_file() {
  if [ "$CLAUDE_AUTH_MODE" = "environment" ] && [ -n "$CLAUDE_API_KEY" ]; then
    mkdir -p "$(dirname "$CLAUDE_API_KEY_FILE")"
    umask 077
    printf '%s\n' "$CLAUDE_API_KEY" > "$CLAUDE_API_KEY_FILE"
    chmod 600 "$CLAUDE_API_KEY_FILE"
  fi
}

stage_file_atomically() {
  local source="$1" target="$2" mode="$3"
  local target_dir staged
  target_dir="$(dirname "$target")"
  mkdir -p "$target_dir"
  staged="$(mktemp "$target_dir/.xuanwu-stage.XXXXXX")"
  if ! { cp "$source" "$staged" && chmod "$mode" "$staged" && mv -f "$staged" "$target"; }; then
    rm -f "$staged"
    return 1
  fi
}

stage_dir_atomically() {
  local source="$1" target="$2"
  local target_dir staged previous
  target_dir="$(dirname "$target")"
  mkdir -p "$target_dir"
  staged="$(mktemp -d "$target_dir/.xuanwu-dir-stage.XXXXXX")"
  previous="$target_dir/.xuanwu-dir-previous.$$"
  rm -rf "$previous"
  if ! cp -R "$source/." "$staged/"; then
    rm -rf "$staged"
    return 1
  fi
  if [ -e "$target" ]; then mv "$target" "$previous"; fi
  if ! mv "$staged" "$target"; then
    [ -e "$previous" ] && mv "$previous" "$target"
    return 1
  fi
  [ -e "$previous" ] && rm -rf "$previous"
}

stage_launchd_binary() {
  # Never truncate a running Mach-O in place. macOS can mark that vnode's code
  # pages as tainted, after which launchd rejects even a valid new signature.
  stage_file_atomically "$BINARY_PATH" "$LAUNCHD_BINARY_PATH" 0755
  if [ -f "$BINARY_PATH.build.stamp" ]; then
    stage_file_atomically "$BINARY_PATH.build.stamp" "$LAUNCHD_BINARY_PATH.build.stamp" 0644
  fi
}

stage_claude_sdk_executable() {
  if [ ! -f "$CLAUDE_SDK_EXECUTABLE_SOURCE" ]; then
    [ "$CLAUDE_MODE" = "cli-fallback" ] && return 0
    echo "[launchd] missing Claude Agent SDK native executable: $CLAUDE_SDK_EXECUTABLE_SOURCE" >&2
    exit 1
  fi
  stage_file_atomically "$CLAUDE_SDK_EXECUTABLE_SOURCE" "$CLAUDE_SDK_EXECUTABLE_PATH" 0755
}

stage_qodercli_runtime() {
  [ -f "$QODERCLI_EXECUTABLE_SOURCE" ] || {
    echo "[launchd] missing exact-pinned Qoder CLI executable: $QODERCLI_EXECUTABLE_SOURCE" >&2
    exit 1
  }
  [ -f "$QODERCLI_RUNTIME_SOURCE/policies/sandbox-default.toml" ] || {
    echo "[launchd] missing Qoder CLI runtime policies: $QODERCLI_RUNTIME_SOURCE/policies/sandbox-default.toml" >&2
    exit 1
  }
  stage_dir_atomically "$QODERCLI_RUNTIME_SOURCE" "$QODERCLI_RUNTIME_PATH"
}

stage_pi_policy_extension() {
  [ -f "$PI_POLICY_EXTENSION_SOURCE" ] || {
    echo "[launchd] missing Pi policy extension: $PI_POLICY_EXTENSION_SOURCE" >&2
    exit 1
  }
  stage_file_atomically "$PI_POLICY_EXTENSION_SOURCE" "$PI_POLICY_EXTENSION_PATH" 0644
}

backup_current_runtime() {
  local rollback_dir="" source
  for source in "$LAUNCHD_BINARY_PATH" "$LAUNCHD_BINARY_PATH.claude-agent-sdk" "$QODERCLI_RUNTIME_PATH" "$LEGACY_QODERCLI_EXECUTABLE_PATH" "$LAUNCHD_BINARY_PATH.pi-policy-extension.ts" "$LAUNCHD_BINARY_PATH.build.stamp" "$LEGACY_PLIST" "$WEB_PLIST" "$CORE_PLIST" "$AGENTIC_PLIST"; do
    [ -e "$source" ] || continue
    if [ -z "$rollback_dir" ]; then
      rollback_dir="$APP_SUPPORT_DIR/rollback/$(date -u '+%Y%m%dT%H%M%SZ')"
      mkdir -p "$rollback_dir"
    fi
    if [ -d "$source" ]; then
      cp -R "$source" "$rollback_dir/$(basename "$source")"
    else
      cp -p "$source" "$rollback_dir/$(basename "$source")"
    fi
  done
  if [ -n "$rollback_dir" ]; then
    printf '%s\n' "$rollback_dir" > "$STATE_DIR/latest-runtime-rollback"
    echo "[launchd] rollback snapshot: $rollback_dir"
  fi
}

stage_web_dir() {
  rm -rf "$WEB_DIR"
  mkdir -p "$(dirname "$WEB_DIR")"
  cp -R "$SOURCE_WEB_DIR" "$WEB_DIR"
}

copy_if_exists() {
  local source="$1" target="$2"
  [ -e "$source" ] || return 0
  rm -rf "$target"
  cp -R "$source" "$target"
}

stage_pi_package_assets() {
  [ -f "$PI_PACKAGE_ASSET_SOURCE/package.json" ] || {
    echo "[launchd] missing PI package assets: $PI_PACKAGE_ASSET_SOURCE/package.json" >&2
    exit 1
  }
  rm -rf "$PI_PACKAGE_ASSET_DIR"
  mkdir -p "$PI_PACKAGE_ASSET_DIR"
  cp "$PI_PACKAGE_ASSET_SOURCE/package.json" "$PI_PACKAGE_ASSET_DIR/package.json"
  copy_if_exists "$PI_PACKAGE_ASSET_SOURCE/README.md" "$PI_PACKAGE_ASSET_DIR/README.md"
  copy_if_exists "$PI_PACKAGE_ASSET_SOURCE/CHANGELOG.md" "$PI_PACKAGE_ASSET_DIR/CHANGELOG.md"
  copy_if_exists "$PI_PACKAGE_ASSET_SOURCE/docs" "$PI_PACKAGE_ASSET_DIR/docs"
  copy_if_exists "$PI_PACKAGE_ASSET_SOURCE/examples" "$PI_PACKAGE_ASSET_DIR/examples"
  copy_if_exists "$PI_PACKAGE_ASSET_SOURCE/dist/modes/interactive/theme" "$PI_PACKAGE_ASSET_DIR/theme"
  copy_if_exists "$PI_PACKAGE_ASSET_SOURCE/dist/modes/interactive/assets" "$PI_PACKAGE_ASSET_DIR/assets"
  copy_if_exists "$PI_PACKAGE_ASSET_SOURCE/dist/core/export-html" "$PI_PACKAGE_ASSET_DIR/export-html"
  copy_if_exists "$RUNNER_SKILLS_SOURCE" "$PI_PACKAGE_ASSET_DIR/skills"
  copy_if_exists "$RUNNER_PLUGINS_SOURCE" "$PI_PACKAGE_ASSET_DIR/plugins"
  copy_if_exists "$PHOTON_WASM_SOURCE" "$(dirname "$LAUNCHD_BINARY_PATH")/photon_rs_bg.wasm"
}

wait_for_health() {
  local url="$1"
  for _ in {1..120}; do
    curl --connect-timeout 1 --max-time 2 -fsS "$url/health" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

launchd_service_pid() {
  launchctl print "$DOMAIN/$1" 2>/dev/null |
    awk '/^[[:space:]]*pid =/ { print $3; exit }'
}

wait_for_service_unloaded() {
  local label="$1"
  for _ in {1..60}; do
    if ! launchctl print "$DOMAIN/$label" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  echo "[launchd] timed out waiting for $label to unload" >&2
  return 1
}

wait_for_process_exit() {
  local pid="${1:-}" label="$2"
  [ -n "$pid" ] || return 0
  for _ in {1..60}; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  echo "[launchd] timed out waiting for old $label process $pid to exit" >&2
  return 1
}

bootstrap_service() {
  local label="$1" plist="$2" attempt output status
  for attempt in {1..20}; do
    if output="$(launchctl bootstrap "$DOMAIN" "$plist" 2>&1)"; then
      return 0
    else
      status=$?
    fi
    # A transient launchd reply can race with successful registration.
    if launchctl print "$DOMAIN/$label" >/dev/null 2>&1; then
      echo "[launchd] $label registered despite bootstrap status $status"
      return 0
    fi
    if [ "$attempt" -lt 20 ]; then
      echo "[launchd] bootstrap $label retry $attempt/20 after status $status" >&2
      sleep 0.25
      continue
    fi
    printf '%s\n' "$output" >&2
    return "$status"
  done
}

if [ -z "$CODEX_CMD" ]; then
  echo "[launchd] codex command not found; set XUANWU_CODEX_CMD=/absolute/path/to/codex" >&2
  exit 1
fi

case "$CLAUDE_AUTH_MODE" in
  environment) ;;
  local-cli)
    [ "$CLAUDE_MODE" = "cli-fallback" ] || { echo "[launchd] XUANWU_CLAUDE_AUTH_MODE=local-cli requires cli-fallback mode" >&2; exit 1; }
    ;;
  platform-profile)
    [ "$CLAUDE_MODE" = "sdk" ] || { echo "[launchd] XUANWU_CLAUDE_AUTH_MODE=platform-profile requires sdk mode" >&2; exit 1; }
    ;;
  *) echo "[launchd] XUANWU_CLAUDE_AUTH_MODE must be environment, local-cli, or platform-profile" >&2; exit 1 ;;
esac
case "$QODER_AUTH_MODE" in
  local-cli|pat-env) ;;
  pat-secret-ref|service-account-secret-ref)
    [ -n "$QODER_CREDENTIAL_REF" ] || { echo "[launchd] XUANWU_QODER_CREDENTIAL_REF is required for $QODER_AUTH_MODE" >&2; exit 1; }
    ;;
  *) echo "[launchd] XUANWU_QODER_AUTH_MODE must be local-cli, pat-env, pat-secret-ref, or service-account-secret-ref" >&2; exit 1 ;;
esac
if [ -n "$CLAUDE_PLATFORM_PROFILE" ] && [[ ! "$CLAUDE_PLATFORM_PROFILE" =~ ^[A-Za-z0-9_.-]+$ || "$CLAUDE_PLATFORM_PROFILE" = "." || "$CLAUDE_PLATFORM_PROFILE" = ".." ]]; then
  echo "[launchd] XUANWU_CLAUDE_PLATFORM_PROFILE is invalid" >&2
  exit 1
fi

if [[ "$AUTOMATION_SHADOW_W1" != "0" && "$AUTOMATION_SHADOW_W1" != "1" ]]; then
  echo "[launchd] XUANWU_AUTOMATION_SHADOW_W1 must be 0 or 1" >&2
  exit 1
fi

if [[ "$SKIP_RUNTIME_BACKUP" != "0" && "$SKIP_RUNTIME_BACKUP" != "1" ]]; then
  echo "[launchd] XUANWU_SKIP_RUNTIME_BACKUP must be 0 or 1" >&2
  exit 1
fi

APP_VERSION="$("$ROOT_DIR/scripts/resolve-version.sh")"
echo "[launchd] version: $APP_VERSION"
env VITE_APP_VERSION="$APP_VERSION" npm --prefix "$ROOT_DIR/frontend" run build
XUANWU_CODESIGN_IDENTIFIER="${XUANWU_CODESIGN_IDENTIFIER:-$LABEL}" \
XUANWU_VERSION="$APP_VERSION" \
  "$ROOT_DIR/backend-ts/scripts/build-binary.sh"
mkdir -p "$STATE_DIR" "$(dirname "$DB_PATH")" "$(dirname "$AUTH_TOKEN_FILE")" "$LOG_DIR" "$HOME/Library/LaunchAgents"
if [ "$SKIP_RUNTIME_BACKUP" = "1" ]; then
  echo "[launchd] runtime rollback snapshot skipped by request"
else
  backup_current_runtime
fi
stage_launchd_binary
stage_claude_sdk_executable
stage_qodercli_runtime
stage_pi_policy_extension
stage_pi_package_assets
stage_web_dir
ensure_auth_token_file
write_claude_api_key_file

cat > "$WEB_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$WEB_LABEL")</string>
  <key>Program</key>
  <string>$(xml_escape "$LAUNCHD_BINARY_PATH")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$LAUNCHD_BINARY_PATH")</string>
    <string>serve</string>
    <string>--role</string>
    <string>web</string>
    <string>--addr</string>
    <string>$(xml_escape "$ADDR")</string>
    <string>--core-addr</string>
    <string>$(xml_escape "$CORE_ADDR")</string>
    <string>--web-dir</string>
    <string>$(xml_escape "$WEB_DIR")</string>
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

cat > "$CORE_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$CORE_LABEL")</string>
  <key>Program</key>
  <string>$(xml_escape "$LAUNCHD_BINARY_PATH")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$LAUNCHD_BINARY_PATH")</string>
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
    <string>$(xml_escape "$CODEX_CMD")</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$(xml_escape "$HOME")</string>
    <key>PATH</key>
    <string>$(xml_escape "$PATH_VALUE")</string>
    <key>PI_PACKAGE_DIR</key>
    <string>$(xml_escape "$PI_PACKAGE_ASSET_DIR")</string>
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
    <key>XUANWU_MANAGED_EXECUTION</key>
    <string>1</string>
    <key>XUANWU_AUTOMATION_SHADOW_W1</key>
    <string>$(xml_escape "$AUTOMATION_SHADOW_W1")</string>
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

cat > "$AGENTIC_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$AGENTIC_LABEL")</string>
  <key>Program</key>
  <string>$(xml_escape "$LAUNCHD_BINARY_PATH")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$LAUNCHD_BINARY_PATH")</string>
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
    <string>$(xml_escape "$PI_PACKAGE_ASSET_DIR")</string>
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

plutil -lint "$WEB_PLIST" >/dev/null
plutil -lint "$CORE_PLIST" >/dev/null
plutil -lint "$AGENTIC_PLIST" >/dev/null
old_legacy_pid="$(launchd_service_pid "$LABEL" || true)"
old_web_pid="$(launchd_service_pid "$WEB_LABEL" || true)"
old_core_pid="$(launchd_service_pid "$CORE_LABEL" || true)"
old_agentic_pid="$(launchd_service_pid "$AGENTIC_LABEL" || true)"
launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || launchctl bootout "$DOMAIN" "$LEGACY_PLIST" >/dev/null 2>&1 || true
rm -f "$LEGACY_PLIST"
launchctl bootout "$DOMAIN/$WEB_LABEL" >/dev/null 2>&1 || true
launchctl bootout "$DOMAIN/$CORE_LABEL" >/dev/null 2>&1 || true
launchctl bootout "$DOMAIN/$AGENTIC_LABEL" >/dev/null 2>&1 || true
wait_for_service_unloaded "$LABEL"
wait_for_service_unloaded "$WEB_LABEL"
wait_for_service_unloaded "$CORE_LABEL"
wait_for_service_unloaded "$AGENTIC_LABEL"
wait_for_process_exit "$old_legacy_pid" "$LABEL"
wait_for_process_exit "$old_web_pid" "$WEB_LABEL"
wait_for_process_exit "$old_core_pid" "$CORE_LABEL"
wait_for_process_exit "$old_agentic_pid" "$AGENTIC_LABEL"
launchctl enable "$DOMAIN/$CORE_LABEL" >/dev/null 2>&1 || true
bootstrap_service "$CORE_LABEL" "$CORE_PLIST"
launchctl kickstart -k "$DOMAIN/$CORE_LABEL"
wait_for_health "$(service_url "$CORE_ADDR")"
launchctl enable "$DOMAIN/$AGENTIC_LABEL" >/dev/null 2>&1 || true
bootstrap_service "$AGENTIC_LABEL" "$AGENTIC_PLIST"
launchctl kickstart -k "$DOMAIN/$AGENTIC_LABEL"
wait_for_health "$(service_url "$AGENTIC_ADDR")"
launchctl enable "$DOMAIN/$WEB_LABEL" >/dev/null 2>&1 || true
bootstrap_service "$WEB_LABEL" "$WEB_PLIST"
launchctl kickstart -k "$DOMAIN/$WEB_LABEL"
wait_for_health "$(service_url "$ADDR")"

"$ROOT_DIR/scripts/status-launchd.sh"
echo "[launchd] installed plists: $WEB_PLIST $CORE_PLIST $AGENTIC_PLIST"
echo "[launchd] binary: $LAUNCHD_BINARY_PATH"
echo "[launchd] web: $WEB_DIR"
echo "[launchd] logs: $LOG_DIR/launchd.web.*.log $LOG_DIR/launchd.agentic.*.log $LOG_DIR/launchd.out.log $LOG_DIR/launchd.err.log"
print_auth_token_guidance
