import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const daemon = join(root, 'scripts', 'daemon.sh');

test('macOS daemon lifecycle is repeatable and uninstall preserves state', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'xuanwu-daemon-'));
  try {
    const home = join(temp, 'home');
    const fakeBin = join(temp, 'bin');
    const state = join(temp, 'state');
    const install = join(temp, 'install');
    const log = join(temp, 'calls.log');
    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    await mkdir(install, { recursive: true });
    await mkdir(state, { recursive: true });
    await writeFile(join(home, 'Library', 'LaunchAgents', 'test.runner.plist'), '<plist/>');
    await writeFile(join(state, 'runner.db'), 'preserve-me');
    await writeExecutable(join(fakeBin, 'uname'), '#!/bin/sh\necho Darwin\n');
    await writeExecutable(join(fakeBin, 'launchctl'), '#!/bin/sh\necho "launchctl $*" >> "$CALL_LOG"\nexit 0\n');
    await writeExecutable(join(fakeBin, 'curl'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(join(install, 'xuanwu'), '#!/bin/sh\necho "runner $*" >> "$CALL_LOG"\necho "{\\"ok\\":true}"\n');
    const env = {
      ...process.env,
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH}`,
      CALL_LOG: log,
      XUANWU_LAUNCHD_LABEL: 'test.runner',
      XUANWU_INSTALL_DIR: install,
      XUANWU_STATE_DIR: state,
      XUANWU_ADDR: '127.0.0.1:3999'
    };

    for (const action of ['start', 'start', 'doctor', 'uninstall']) {
      const result = spawnSync('bash', [daemon, action], { env, encoding: 'utf8' });
      assert.equal(result.status, 0, `${action}: ${result.stderr}`);
    }

    const calls = await readFile(log, 'utf8');
    assert.match(calls, /launchctl bootstrap gui\/\d+ .*test\.runner\.plist/);
    assert.match(calls, /launchctl enable gui\/\d+\/test\.runner/);
    assert.ok(
      calls.indexOf('launchctl enable') < calls.indexOf('launchctl bootstrap'),
      'disabled launchd labels must be enabled before bootstrap'
    );
    assert.match(calls, /runner system doctor --addr 127\.0\.0\.1:3999 --token-file/);
    assert.equal(await readFile(join(state, 'runner.db'), 'utf8'), 'preserve-me');
    await assert.rejects(readFile(join(home, 'Library', 'LaunchAgents', 'test.runner.plist')));
    const audit = await readFile(join(state, 'logs', 'daemon-lifecycle.log'), 'utf8');
    assert.match(audit, /action=start outcome=applied/);
    assert.match(audit, /action=uninstall outcome=applied/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

async function writeExecutable(path, content) {
  await writeFile(path, content);
  await chmod(path, 0o755);
}

test('release and source launchd installers declare background daemon policy', async () => {
  const [release, source, packager] = await Promise.all([
    readFile(join(root, 'scripts', 'install-release.sh'), 'utf8'),
    readFile(join(root, 'scripts', 'install-launchd.sh'), 'utf8'),
    readFile(join(root, 'scripts', 'package-release.sh'), 'utf8')
  ]);
  assert.match(release, /loginctl enable-linger "\$USER"/);
  assert.match(release, /<key>ProcessType<\/key>\s*\n  <string>Background<\/string>/);
  assert.match(source, /<key>ProcessType<\/key>\s*\n  <string>Background<\/string>/);
  assert.match(release, /\.xuanwu\.stage\.\$\$/);
  assert.match(packager, /cp "\$ROOT_DIR\/scripts\/daemon\.sh" "\$pkg_dir\/daemon\.sh"/);
  assert.match(release, /serve --role core --addr \$CORE_ADDR/);
  assert.match(release, /serve --role agentic --addr \$AGENTIC_ADDR/);
  assert.match(release, /serve --role web --addr \$ADDR --core-addr \$CORE_ADDR/);
  assert.match(release, /\$SERVICE_NAME-core\.service/);
  assert.match(release, /\$SERVICE_NAME-agentic\.service/);
  assert.match(release, /\$SERVICE_NAME-web\.service/);
  assert.doesNotMatch(release, /Requires=\$SERVICE_NAME-core\.service/);
  assert.ok(
    release.indexOf('launchctl enable "$domain/$CORE_LABEL"') <
      release.indexOf('launchctl bootstrap "$domain" "$core_plist"'),
    'release installer must enable a stopped label before bootstrap'
  );
  assert.match(await readFile(join(root, 'scripts', 'daemon.sh'), 'utf8'), /restart "\$SERVICE_NAME-core\.service" "\$SERVICE_NAME-agentic\.service" "\$SERVICE_NAME-web\.service"/);
  assert.match(source, /<string>--core-addr<\/string>/);
});

test('release installer can repeat an atomic macOS upgrade without replacing state', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'xuanwu-release-'));
  try {
    const home = join(temp, 'home');
    const fakeBin = join(temp, 'bin');
    const state = join(temp, 'state');
    const install = join(temp, 'install');
    const fixture = join(temp, 'fixture');
    const release = join(temp, 'release');
    const archive = join(release, 'xuanwu_darwin_arm64.tar.gz');
    const calls = join(temp, 'calls.log');
    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    await mkdir(state, { recursive: true });
    await mkdir(fixture, { recursive: true });
    await mkdir(release, { recursive: true });
    await writeFile(join(state, 'runner.db'), 'state-survives-upgrade');
    await writeExecutable(join(fixture, 'xuanwu'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "xuanwu v1.2.3 build=test bun=test"; fi\nexit 0\n');
    await writeExecutable(join(fixture, 'xuanwu.claude-agent-sdk'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(join(fixture, 'xuanwu.qodercli.mjs'), '#!/bin/sh\necho 1.1.18\n');
    await writeFile(join(fixture, 'daemon.sh'), await readFile(daemon));
    await chmod(join(fixture, 'daemon.sh'), 0o755);
    assert.equal(spawnSync('tar', ['-czf', archive, '-C', fixture, '.']).status, 0);
    const metadata = join(release, 'release.json');
    await writeFile(metadata, '{\n  "version": "v1.2.3"\n}\n');
    await writeFile(join(release, 'checksums.txt'), [
      `${await sha256(archive)}  xuanwu_darwin_arm64.tar.gz`,
      `${await sha256(metadata)}  release.json`,
      ''
    ].join('\n'));
    await writeExecutable(join(fakeBin, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo arm64 ;; esac\n');
    await writeExecutable(join(fakeBin, 'curl'), '#!/bin/sh\nout=""; url=""; previous=""\nfor arg in "$@"; do if [ "$previous" = "-o" ]; then out="$arg"; fi; case "$arg" in http*) url="$arg" ;; esac; previous="$arg"; done\nif [ -n "$out" ]; then cp "$FIXTURE_RELEASE_DIR/${url##*/}" "$out"; fi\nexit 0\n');
    await writeExecutable(join(fakeBin, 'codex'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(join(fakeBin, 'plutil'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(join(fakeBin, 'launchctl'), '#!/bin/sh\necho "launchctl $*" >> "$CALL_LOG"\nexit 0\n');
    const env = {
      ...process.env,
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH}`,
      CALL_LOG: calls,
      FIXTURE_RELEASE_DIR: release,
      XUANWU_INSTALL_DIR: install,
      XUANWU_STATE_DIR: state,
      XUANWU_ADDR: '127.0.0.1:3999',
      XUANWU_VERSION: 'v1.2.3',
      XUANWU_VERIFY_ATTESTATION: 'skip'
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = spawnSync('bash', [join(root, 'scripts', 'install-release.sh')], { env, encoding: 'utf8' });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    }
    assert.equal(await readFile(join(state, 'runner.db'), 'utf8'), 'state-survives-upgrade');
    assert.match(await readFile(calls, 'utf8'), /launchctl kickstart -k gui\/\d+\/com\.xiaobei\.xuanwu/);
    assert.equal(await readFile(join(install, 'xuanwu-daemon'), 'utf8'), await readFile(join(fixture, 'daemon.sh'), 'utf8'));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
