import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const source = readFileSync(new URL('./install-launchd.sh', import.meta.url), 'utf8');
const releaseSource = readFileSync(new URL('./install-release.sh', import.meta.url), 'utf8');
const redeploy = readFileSync(new URL('../redeploy.sh', import.meta.url), 'utf8');
const installScript = new URL('./install-launchd.sh', import.meta.url);
const installReleaseScript = new URL('./install-release.sh', import.meta.url);
const redeployScript = new URL('../redeploy.sh', import.meta.url);
const updateReleaseScript = new URL('./update-release.sh', import.meta.url);
const daemonScript = new URL('./daemon.sh', import.meta.url);

test('launchd deployment atomically replaces the running Mach-O inode', () => {
  assert.match(source, /stage_file_atomically\(\)/);
  assert.match(source, /mktemp "\$target_dir\/\.xuanwu-stage\.XXXXXX"/);
  assert.match(source, /mv -f "\$staged" "\$target"/);
  assert.match(source, /stage_file_atomically "\$BINARY_PATH" "\$LAUNCHD_BINARY_PATH" 0755/);
  assert.doesNotMatch(source, /cp "\$BINARY_PATH" "\$LAUNCHD_BINARY_PATH"/);
});

test('launchd deployment stages controlled PI runtime resources with package assets', () => {
  assert.match(source, /RUNNER_SKILLS_SOURCE=.*\$ROOT_DIR\/skills/);
  assert.match(source, /copy_if_exists "\$RUNNER_SKILLS_SOURCE" "\$PI_PACKAGE_ASSET_DIR\/skills"/);
  assert.match(source, /copy_if_exists "\$RUNNER_PLUGINS_SOURCE" "\$PI_PACKAGE_ASSET_DIR\/plugins"/);
  assert.match(source, /<key>PI_PACKAGE_DIR<\/key>/);
});

test('launchd deployment persists the explicit W1 automation shadow selector', () => {
  assert.match(source, /AUTOMATION_SHADOW_W1="\$\{XUANWU_AUTOMATION_SHADOW_W1:-0\}"/);
  assert.match(source, /XUANWU_AUTOMATION_SHADOW_W1 must be 0 or 1/);
  assert.match(source, /<key>XUANWU_AUTOMATION_SHADOW_W1<\/key>/);
  assert.match(source, /<string>\$\(xml_escape "\$AUTOMATION_SHADOW_W1"\)<\/string>/);
});

test('deployment creates a mode-0600 remote access token and only reveals a fresh value on an interactive terminal', () => {
  for (const script of [source, releaseSource]) {
    assert.match(script, /ensure_auth_token_file\(\)/);
    assert.match(script, /openssl rand -base64 32/);
    assert.match(script, /chmod 600 "\$AUTH_TOKEN_FILE"/);
    assert.match(script, /AUTH_TOKEN_CREATED/);
    assert.match(script, /\[ -t 1 \]/);
    assert.match(script, /remote access token \(shown once\)/);
    assert.match(script, /read later: cat/);
  }
});

test('launchd Core marks Runner-managed provider execution', () => {
  assert.match(source, /<key>XUANWU_MANAGED_EXECUTION<\/key>\s*<string>1<\/string>/);
});

test('deployment persists Claude SDK auth through a mode-0600 key file instead of service arguments', () => {
  for (const script of [source, releaseSource]) {
    assert.match(script, /CLAUDE_API_KEY_FILE="\$\{XUANWU_CLAUDE_API_KEY_FILE:-\$STATE_DIR\/claude_api_key\}"/);
    assert.match(script, /printf '%s\\n' "\$CLAUDE_API_KEY" > "\$CLAUDE_API_KEY_FILE"/);
    assert.match(script, /chmod 600 "\$CLAUDE_API_KEY_FILE"/);
    assert.match(script, /XUANWU_CLAUDE_API_KEY_FILE/);
    assert.doesNotMatch(script, /XUANWU_CLAUDE_API_KEY<\/key>/);
    assert.doesNotMatch(script, /Environment="XUANWU_CLAUDE_API_KEY=/);
  }
});

test('deployment persists explicit Claude local CLI and Anthropic platform profile auth selectors without tokens', () => {
  for (const script of [source, releaseSource]) {
    assert.match(script, /XUANWU_CLAUDE_AUTH_MODE/);
    assert.match(script, /XUANWU_CLAUDE_PLATFORM_CONFIG_DIR/);
    assert.match(script, /XUANWU_CLAUDE_PLATFORM_PROFILE/);
    assert.match(script, /local-cli/);
    assert.match(script, /platform-profile/);
    assert.doesNotMatch(script, /CLAUDE_CODE_OAUTH_TOKEN<\/key>/);
    assert.doesNotMatch(script, /Environment="CLAUDE_CODE_OAUTH_TOKEN=/);
    assert.doesNotMatch(script, /ANTHROPIC_AUTH_TOKEN<\/key>/);
    assert.doesNotMatch(script, /Environment="ANTHROPIC_AUTH_TOKEN=/);
  }
});

test('deployment defaults Claude to SDK transport with reusable local CLI authentication', () => {
  for (const script of [source, releaseSource]) {
    assert.match(script, /if \[ -z "\$CLAUDE_MODE" \]; then\s+CLAUDE_MODE="sdk"\s+fi/);
    assert.match(script, /elif \[ -z "\$CLAUDE_API_KEY" \] && \[ ! -s "\$CLAUDE_API_KEY_FILE" \]; then\s+CLAUDE_AUTH_MODE="local-cli"/);
    assert.doesNotMatch(script, /XUANWU_CLAUDE_AUTH_MODE=local-cli requires (?:cli-fallback|XUANWU_CLAUDE_MODE=cli-fallback)/);
  }
});

test('deployment stages the adjacent Claude SDK native executable atomically and snapshots it', () => {
  assert.match(source, /stage_file_atomically "\$CLAUDE_SDK_EXECUTABLE_SOURCE" "\$CLAUDE_SDK_EXECUTABLE_PATH" 0755/);
  assert.match(source, /"\$LAUNCHD_BINARY_PATH\.claude-agent-sdk"/);
  assert.match(releaseSource, /release asset does not contain Claude Agent SDK native executable/);
  assert.match(releaseSource, /mv -f "\$sdk_staged" "\$CLAUDE_SDK_EXECUTABLE_PATH"/);
});

test('deployment requires, stages, and snapshots the exact-pinned Qoder CLI runtime', () => {
  assert.match(source, /stage_dir_atomically "\$QODERCLI_RUNTIME_SOURCE" "\$QODERCLI_RUNTIME_PATH"/);
  assert.match(source, /if \[ -e "\$previous" \]; then\s+rm -rf "\$previous"\s+fi\s+return 0/);
  assert.match(source, /policies\/sandbox-default\.toml/);
  assert.match(source, /"\$QODERCLI_RUNTIME_PATH"/);
  assert.match(releaseSource, /release asset does not contain exact-pinned Qoder CLI executable/);
  assert.match(releaseSource, /release asset does not contain Qoder CLI runtime policies/);
  assert.match(releaseSource, /Qoder CLI version \$qoder_version does not match required 1\.1\.18/);
  assert.match(releaseSource, /mv "\$qoder_staged" "\$QODERCLI_RUNTIME_PATH"/);
});

test('launchd deployment defaults to split Web/Core/Agentic roles from one artifact', () => {
  assert.match(source, /WEB_LABEL="\$\{LABEL\}\.web"/);
  assert.match(source, /CORE_LABEL="\$\{LABEL\}\.core"/);
  assert.match(source, /AGENTIC_LABEL="\$\{LABEL\}\.agentic"/);
  assert.match(source, /<string>web<\/string>/);
  assert.match(source, /<string>core<\/string>/);
  assert.match(source, /<string>agentic<\/string>/);
  assert.match(source, /<string>--core-addr<\/string>/);
  assert.equal((source.match(/<string>--db<\/string>/g) || []).length, 2);
  assert.equal((source.match(/<key>PI_PACKAGE_DIR<\/key>/g) || []).length, 2);
  assert.match(source, /wait_for_health "\$\(service_url "\$CORE_ADDR"\)"/);
  assert.match(source, /wait_for_health "\$\(service_url "\$AGENTIC_ADDR"\)"/);
  assert.match(source, /wait_for_health "\$\(service_url "\$ADDR"\)"/);
  assert.match(source, /curl --connect-timeout 1 --max-time 2 -fsS/);
});

test('launchd deployment preserves rollback inputs before atomic replacement', () => {
  assert.match(source, /backup_current_runtime\(\)/);
  assert.match(source, /latest-runtime-rollback/);
  assert.match(source, /else\s+backup_current_runtime\s+fi\s+stage_launchd_binary/);
});

test('launchd deployment waits for old split services before bounded bootstrap retries', () => {
  assert.match(source, /launchd_service_pid\(\)/);
  assert.match(source, /wait_for_service_unloaded\(\)/);
  assert.match(source, /wait_for_process_exit\(\)/);
  assert.match(source, /bootstrap_service\(\)/);
  assert.match(source, /for attempt in \{1\.\.20\}/);
  assert.match(source, /old_core_pid="\$\(launchd_service_pid "\$CORE_LABEL" \|\| true\)"/);
  assert.match(source, /old_agentic_pid="\$\(launchd_service_pid "\$AGENTIC_LABEL" \|\| true\)"/);
  assert.match(source, /wait_for_process_exit "\$old_core_pid" "\$CORE_LABEL"/);
  assert.match(source, /bootstrap_service "\$CORE_LABEL" "\$CORE_PLIST"/);
  assert.match(source, /bootstrap_service "\$AGENTIC_LABEL" "\$AGENTIC_PLIST"/);
  assert.ok(
    source.indexOf('wait_for_process_exit "$old_core_pid" "$CORE_LABEL"') <
      source.indexOf('bootstrap_service "$CORE_LABEL" "$CORE_PLIST"'),
    'Core bootstrap must happen only after the previous Core PID exits'
  );
  assert.ok(
    source.indexOf('launchctl enable "$DOMAIN/$CORE_LABEL"') <
      source.indexOf('bootstrap_service "$CORE_LABEL" "$CORE_PLIST"'),
    'Core label must be enabled before bootstrap after a maintenance stop'
  );
});

test('redeploy snapshots and quick-checks the live DB before replacing runtime', () => {
  assert.match(redeploy, /source\.backup\(target\)/);
  assert.match(redeploy, /pragma quick_check/);
  assert.match(redeploy, /latest-predeploy-backup/);
  assert.match(redeploy, /backup_live_database\s*\nlog "building and restarting/);
});

test('redeploy bounds predeploy DB backups before creating a fresh snapshot', () => {
  assert.match(redeploy, /XUANWU_PREDEPLOY_BACKUP_RETAIN:-5/);
  assert.match(redeploy, /predeploy-\\d\{8\}T\\d\{6\}Z/);
  assert.match(redeploy, /len\(backups\) - \(retain - 1\)/);
  assert.match(redeploy, /shutil\.rmtree\(path\)/);
});

test('Runner-managed provider processes cannot enter live deployment', () => {
  const managedEnvironments = [
    { ...process.env, XUANWU_MANAGED_EXECUTION: '1' },
    {
      ...process.env,
      XUANWU_CODEX_SERVER_MODE: 'cli',
      PI_PACKAGE_DIR: '/tmp/runner-managed-pi-package'
    }
  ];
  for (const env of managedEnvironments) {
    for (const script of [redeployScript, installScript, installReleaseScript, updateReleaseScript]) {
      const result = spawnSync('bash', [script.pathname], { encoding: 'utf8', env });
      assert.equal(result.status, 78);
      assert.match(result.stderr, /live deployment cannot run from a Runner-managed provider process/);
      if (script === redeployScript || script === installScript) {
        assert.match(result.stderr, /\.\/dev\.sh with isolated state and non-live ports/);
      }
    }
    const daemon = spawnSync('bash', [daemonScript.pathname, 'restart'], { encoding: 'utf8', env });
    assert.equal(daemon.status, 78);
    assert.match(daemon.stderr, /live service mutation cannot run from a Runner-managed provider process/);
  }
});
