import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const source = readFileSync(new URL('./install-launchd.sh', import.meta.url), 'utf8');
const redeploy = readFileSync(new URL('../redeploy.sh', import.meta.url), 'utf8');
const installScript = new URL('./install-launchd.sh', import.meta.url);
const installReleaseScript = new URL('./install-release.sh', import.meta.url);
const redeployScript = new URL('../redeploy.sh', import.meta.url);
const updateReleaseScript = new URL('./update-release.sh', import.meta.url);
const daemonScript = new URL('./daemon.sh', import.meta.url);

test('launchd deployment atomically replaces the running Mach-O inode', () => {
  assert.match(source, /stage_file_atomically\(\)/);
  assert.match(source, /mktemp "\$target_dir\/\.codex-runner-stage\.XXXXXX"/);
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
  assert.match(source, /AUTOMATION_SHADOW_W1="\$\{CODEX_RUNNER_AUTOMATION_SHADOW_W1:-0\}"/);
  assert.match(source, /CODEX_RUNNER_AUTOMATION_SHADOW_W1 must be 0 or 1/);
  assert.match(source, /<key>CODEX_RUNNER_AUTOMATION_SHADOW_W1<\/key>/);
  assert.match(source, /<string>\$\(xml_escape "\$AUTOMATION_SHADOW_W1"\)<\/string>/);
});

test('launchd Core marks Runner-managed provider execution', () => {
  assert.match(source, /<key>CODEX_RUNNER_MANAGED_EXECUTION<\/key>\s*<string>1<\/string>/);
});

test('launchd deployment defaults to split Web/Core roles from one artifact', () => {
  assert.match(source, /WEB_LABEL="\$\{LABEL\}\.web"/);
  assert.match(source, /CORE_LABEL="\$\{LABEL\}\.core"/);
  assert.match(source, /<string>web<\/string>/);
  assert.match(source, /<string>core<\/string>/);
  assert.match(source, /<string>--core-addr<\/string>/);
  assert.equal((source.match(/<string>--db<\/string>/g) || []).length, 1);
  assert.equal((source.match(/<key>PI_PACKAGE_DIR<\/key>/g) || []).length, 1);
  assert.match(source, /wait_for_health "\$\(service_url "\$CORE_ADDR"\)"/);
  assert.match(source, /wait_for_health "\$\(service_url "\$ADDR"\)"/);
});

test('launchd deployment preserves rollback inputs before atomic replacement', () => {
  assert.match(source, /backup_current_runtime\(\)/);
  assert.match(source, /latest-runtime-rollback/);
  assert.match(source, /backup_current_runtime\s*\nstage_launchd_binary/);
});

test('launchd deployment waits for old split services before bounded bootstrap retries', () => {
  assert.match(source, /launchd_service_pid\(\)/);
  assert.match(source, /wait_for_service_unloaded\(\)/);
  assert.match(source, /wait_for_process_exit\(\)/);
  assert.match(source, /bootstrap_service\(\)/);
  assert.match(source, /for attempt in \{1\.\.20\}/);
  assert.match(source, /old_core_pid="\$\(launchd_service_pid "\$CORE_LABEL" \|\| true\)"/);
  assert.match(source, /wait_for_process_exit "\$old_core_pid" "\$CORE_LABEL"/);
  assert.match(source, /bootstrap_service "\$CORE_LABEL" "\$CORE_PLIST"/);
  assert.ok(
    source.indexOf('wait_for_process_exit "$old_core_pid" "$CORE_LABEL"') <
      source.indexOf('bootstrap_service "$CORE_LABEL" "$CORE_PLIST"'),
    'Core bootstrap must happen only after the previous Core PID exits'
  );
});

test('redeploy snapshots and quick-checks the live DB before replacing runtime', () => {
  assert.match(redeploy, /source\.backup\(target\)/);
  assert.match(redeploy, /pragma quick_check/);
  assert.match(redeploy, /latest-predeploy-backup/);
  assert.match(redeploy, /backup_live_database\s*\nlog "building and restarting/);
});

test('redeploy bounds predeploy DB backups before creating a fresh snapshot', () => {
  assert.match(redeploy, /CODEX_RUNNER_PREDEPLOY_BACKUP_RETAIN:-5/);
  assert.match(redeploy, /predeploy-\\d\{8\}T\\d\{6\}Z/);
  assert.match(redeploy, /len\(backups\) - \(retain - 1\)/);
  assert.match(redeploy, /shutil\.rmtree\(path\)/);
});

test('Runner-managed provider processes cannot enter live deployment', () => {
  const managedEnvironments = [
    { ...process.env, CODEX_RUNNER_MANAGED_EXECUTION: '1' },
    {
      ...process.env,
      CODEX_RUNNER_CODEX_SERVER_MODE: 'cli',
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
