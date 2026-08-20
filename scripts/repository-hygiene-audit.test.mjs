import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const audit = join(root, 'scripts', 'repository-hygiene-audit.mjs');

test('backend hygiene rejects an orphan and accepts the same source once rooted', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'xuanwu-hygiene-'));
  try {
    await write(fixture, 'backend-ts/src/main.ts', "import './reachable.ts';\n");
    await write(fixture, 'backend-ts/src/main.test.ts', "import './main.ts';\n");
    await write(fixture, 'backend-ts/src/reachable.ts', 'export const reachable = true;\n');
    await write(fixture, 'backend-ts/src/orphan.ts', 'export const orphan = true;\n');
    await mkdir(join(fixture, 'scripts'), { recursive: true });

    const failed = run(fixture);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /backend-ts\/src\/orphan\.ts/);

    await write(fixture, 'backend-ts/src/main.ts', "import './reachable.ts';\nimport './orphan.ts';\n");
    const passed = run(fixture);
    assert.equal(passed.status, 0, passed.stderr);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

async function write(base, path, contents) {
  const target = join(base, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

function run(fixture) {
  return spawnSync(process.execPath, [audit, '--backend-graph-root', fixture], {
    cwd: root,
    encoding: 'utf8',
  });
}
