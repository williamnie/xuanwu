import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;

test('fresh install, update check, upgrade, and release-owned rollback preserve authority state', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codex-runner-upgrade-'));
  try {
    const home = join(temp, 'home');
    const fakeBin = join(temp, 'fake-bin');
    const install = join(temp, 'install');
    const state = join(temp, 'state');
    const calls = join(temp, 'calls.log');
    const releaseV1 = await createRelease(temp, 'v1', 'v1.0.0');
    const releaseV2 = await createRelease(temp, 'v2', 'v1.1.0');
    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    await writeExecutable(join(fakeBin, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo arm64 ;; *) echo Darwin ;; esac\n');
    await writeExecutable(join(fakeBin, 'curl'), '#!/bin/sh\nout=""; url=""; previous=""\nfor arg in "$@"; do if [ "$previous" = "-o" ]; then out="$arg"; fi; case "$arg" in http*) url="$arg" ;; esac; previous="$arg"; done\nif [ -n "$out" ]; then cp "$FIXTURE_RELEASE_DIR/${url##*/}" "$out"; fi\nexit 0\n');
    await writeExecutable(join(fakeBin, 'gh'), '#!/bin/sh\necho "gh $*" >> "$CALL_LOG"\n[ "$GH_ATTESTATION_FAIL" = "1" ] && exit 1\nexit 0\n');
    await writeExecutable(join(fakeBin, 'codex'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(join(fakeBin, 'plutil'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(join(fakeBin, 'launchctl'), '#!/bin/sh\necho "launchctl $*" >> "$CALL_LOG"\nexit 0\n');
    const env = {
      ...process.env,
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH}`,
      CALL_LOG: calls,
      CODEX_RUNNER_INSTALL_DIR: install,
      CODEX_RUNNER_STATE_DIR: state,
      CODEX_RUNNER_ADDR: '127.0.0.1:3999',
      CODEX_RUNNER_CLAUDE_AUTH_MODE: 'platform-profile',
      CODEX_RUNNER_CLAUDE_PLATFORM_CONFIG_DIR: join(home, '.config', 'anthropic'),
      CODEX_RUNNER_CLAUDE_PLATFORM_PROFILE: 'runner',
      CODEX_RUNNER_VERIFY_ATTESTATION: 'require',
      FIXTURE_RELEASE_DIR: releaseV1,
    };

    const fresh = spawnSync('bash', [join(root, 'scripts', 'install-release.sh')], { env, encoding: 'utf8' });
    assert.equal(fresh.status, 0, `${fresh.stdout}\n${fresh.stderr}`);
    assert.match(runVersion(join(install, 'codex-issue-runner'), env), /v1\.0\.0/);
    const unsignedAuto = spawnSync('bash', [join(root, 'scripts', 'install-release.sh')], {
      env: { ...env, CODEX_RUNNER_VERIFY_ATTESTATION: 'auto', GH_ATTESTATION_FAIL: '1' }, encoding: 'utf8'
    });
    assert.equal(unsignedAuto.status, 0, `${unsignedAuto.stdout}\n${unsignedAuto.stderr}`);
    assert.match(unsignedAuto.stdout, /SHA-256 verified but signed GitHub provenance is unavailable/);
    const corePlist = await readFile(join(home, 'Library', 'LaunchAgents', 'com.xiaobei.codex-issue-runner.core.plist'), 'utf8');
    assert.match(corePlist, /<key>CODEX_RUNNER_CLAUDE_AUTH_MODE<\/key>\s*<string>platform-profile<\/string>/);
    assert.match(corePlist, /<key>CODEX_RUNNER_CLAUDE_PLATFORM_PROFILE<\/key>\s*<string>runner<\/string>/);
    await writeFile(join(state, 'runner.db'), 'authority-survives-release-changes');

    const updateEnv = { ...env, FIXTURE_RELEASE_DIR: releaseV2 };
    const updater = join(install, 'codex-issue-runner-update');
    const check = spawnSync('bash', [updater, 'check', '--json'], { env: updateEnv, encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
    assert.deepEqual(JSON.parse(check.stdout), { current: 'v1.0.0', latest: 'v1.1.0', update_available: true });

    const denied = spawnSync('bash', [updater, 'upgrade', '--actor', 'release-test', '--actor-kind', 'llm'], {
      env: updateEnv, encoding: 'utf8'
    });
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /mutation requires --apply/);

    const archiveV2 = join(releaseV2, 'codex-issue-runner_darwin_arm64.tar.gz');
    const validArchiveV2 = await readFile(archiveV2);
    await writeFile(archiveV2, Buffer.concat([validArchiveV2, Buffer.from('tampered')]));
    const rejectedInstall = spawnSync('bash', [join(install, 'codex-issue-runner-install')], {
      env: { ...updateEnv, CODEX_RUNNER_VERSION: 'v1.1.0' }, encoding: 'utf8'
    });
    assert.notEqual(rejectedInstall.status, 0);
    assert.match(rejectedInstall.stderr, /SHA-256 mismatch/);
    assert.match(runVersion(join(install, 'codex-issue-runner'), updateEnv), /v1\.0\.0/);
    await writeFile(archiveV2, validArchiveV2);

    const commonGate = [
      '--apply', '--actor', 'release-test', '--actor-kind', 'system',
      '--audit-ref', 'test:release-rehearsal', '--reason', 'isolated rehearsal',
      '--backup-ref', 'fixture:verified-backup'
    ];
    const upgrade = spawnSync('bash', [updater, 'upgrade', ...commonGate, '--confirm-backup-tested'], {
      env: updateEnv, encoding: 'utf8'
    });
    assert.equal(upgrade.status, 0, `${upgrade.stdout}\n${upgrade.stderr}`);
    assert.match(runVersion(join(install, 'codex-issue-runner'), updateEnv), /v1\.1\.0/);
    assert.equal(await readFile(join(state, 'runner.db'), 'utf8'), 'authority-survives-release-changes');

    const rollback = spawnSync('bash', [updater, 'rollback', ...commonGate, '--snapshot', 'latest', '--confirm-data-compatible'], {
      env: updateEnv, encoding: 'utf8'
    });
    assert.equal(rollback.status, 0, `${rollback.stdout}\n${rollback.stderr}`);
    assert.match(runVersion(join(install, 'codex-issue-runner'), updateEnv), /v1\.0\.0/);
    assert.equal(await readFile(join(state, 'runner.db'), 'utf8'), 'authority-survives-release-changes');

    const audit = await readFile(join(state, 'logs', 'release-upgrade.log'), 'utf8');
    assert.match(audit, /action=upgrade outcome=applied from=v1\.0\.0 to=v1\.1\.0/);
    assert.match(audit, /action=rollback outcome=applied from=v1\.1\.0 to=v1\.0\.0/);
    const callLog = await readFile(calls, 'utf8');
    assert.match(callLog, /gh attestation verify .* --repo williamnie\/xuanwu --signer-workflow williamnie\/xuanwu\/\.github\/workflows\/release\.yml/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('release manifest enforces tag format, changelog, and target metadata', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codex-runner-manifest-'));
  try {
    const output = join(temp, 'release.json');
    const result = spawnSync('node', [join(root, 'scripts', 'write-release-manifest.mjs'),
      '--version', 'v0.1.0', '--revision', 'abc123', '--build-stamp', 'stamp-test',
      '--output', output, '--target', 'bun-darwin-arm64', '--require-changelog'
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(manifest.version, 'v0.1.0');
    assert.equal(manifest.source_of_truth, 'runner.db');
    assert.deepEqual(manifest.targets, [{
      asset: 'codex-issue-runner_darwin_arm64.tar.gz',
      target: 'bun-darwin-arm64'
    }]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('release package keeps Bun runtime assets beside the executable and smokes the host binary', async () => {
  const [script, workflow, runbook] = await Promise.all([
    readFile(join(root, 'scripts', 'package-release.sh'), 'utf8'),
    readFile(join(root, '.github', 'workflows', 'release.yml'), 'utf8'),
    readFile(join(root, 'docs', 'runbooks', 'release-upgrade-rollback.md'), 'utf8'),
  ]);
  assert.match(script, /bun test --timeout 60000/);
  assert.match(workflow, /run: bun test --timeout 60000/);
  assert.match(workflow, /if: github\.event\.repository\.private == false/);
  assert.match(runbook, /\(cd dist\/release && shasum -a 256 -c checksums\.txt\)/);
  assert.match(script, /cp "\$source\/package\.json" "\$pkg_dir\/package\.json"/);
  assert.match(script, /"\$pkg_dir\/theme"/);
  assert.match(script, /"\$pkg_dir\/assets"/);
  assert.match(script, /"\$pkg_dir\/export-html"/);
  assert.match(script, /run_step "packaged host binary smoke" "\$binary" --version/);
  assert.match(script, /stage_claude_sdk_executable "\$target" "\$pkg_dir"/);
  assert.match(script, /"\$pkg_dir\/codex-issue-runner\.claude-agent-sdk"/);
  assert.match(script, /"\$ROOT_DIR\/README\.zh-CN\.md" "\$pkg_dir\/README\.zh-CN\.md"/);
  assert.match(script, /"\$ROOT_DIR\/LICENSE" "\$pkg_dir\/LICENSE"/);
  assert.match(script, /"\$ROOT_DIR\/NOTICE" "\$pkg_dir\/NOTICE"/);
  assert.match(script, /"\$ROOT_DIR\/COMMERCIAL-LICENSE\.md" "\$pkg_dir\/COMMERCIAL-LICENSE\.md"/);
  assert.doesNotMatch(script, /"\$pkg_dir\/pi-coding-agent\/package\.json"/);
});

test('release rollback snapshots split and compatibility service registrations', async () => {
  const [installer, updater] = await Promise.all([
    readFile(join(root, 'scripts', 'install-release.sh'), 'utf8'),
    readFile(join(root, 'scripts', 'update-release.sh'), 'utf8'),
  ]);
  assert.doesNotMatch(installer, /rm -f "\$legacy_plist"/);
  assert.match(installer, /disable --now "\$SERVICE_NAME\.service"/);
  assert.match(updater, /\$LABEL\.web\.plist/);
  assert.match(updater, /\$LABEL\.core\.plist/);
  assert.match(updater, /\$SERVICE_NAME-web\.service/);
  assert.match(updater, /\$SERVICE_NAME-core\.service/);
  assert.match(updater, /snapshot\/bin\/codex-issue-runner\.claude-agent-sdk/);
  assert.match(updater, /restore_file "\$snapshot\/bin\/codex-issue-runner\.claude-agent-sdk" "\$CLAUDE_SDK_EXECUTABLE_PATH"/);
  assert.match(updater, /restore_service_registration "\$snapshot"/);
});

async function createRelease(temp, name, version) {
  const release = join(temp, `release-${name}`);
  const fixture = join(temp, `fixture-${name}`);
  await mkdir(release, { recursive: true });
  await mkdir(join(fixture, 'web'), { recursive: true });
  await writeExecutable(join(fixture, 'codex-issue-runner'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-issue-runner ${version} build=test bun=test"; fi\nexit 0\n`);
  await writeExecutable(join(fixture, 'codex-issue-runner.claude-agent-sdk'), '#!/bin/sh\nexit 0\n');
  await writeFile(join(fixture, 'web', 'index.html'), version);
  for (const script of ['daemon.sh', 'install-release.sh', 'update-release.sh']) {
    await writeFile(join(fixture, script), await readFile(join(root, 'scripts', script)));
    await chmod(join(fixture, script), 0o755);
  }
  const archive = join(release, 'codex-issue-runner_darwin_arm64.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', archive, '-C', fixture, '.']).status, 0);
  const metadata = join(release, 'release.json');
  await writeFile(metadata, `${JSON.stringify({ version }, null, 2)}\n`);
  await writeFile(join(release, 'checksums.txt'), [
    `${await sha256(archive)}  codex-issue-runner_darwin_arm64.tar.gz`,
    `${await sha256(metadata)}  release.json`,
    ''
  ].join('\n'));
  return release;
}

function runVersion(binary, env) {
  const result = spawnSync(binary, ['--version'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function writeExecutable(path, content) {
  await writeFile(path, content);
  await chmod(path, 0o755);
}
