import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;

test('Codex installer preserves the complete remote project guide and planning reference', async () => {
  const target = await mkdtemp(join(tmpdir(), 'xuanwu-skill-'));
  try {
    const result = spawnSync('bash', [join(root, 'scripts/install-xuanwu-skill.sh')], {
      env: { ...process.env, XUANWU_CODEX_SKILLS_DIR: target }, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    for (const file of ['SKILL.md', 'references/issue-planning.md']) {
      assert.equal(await readFile(join(target, 'xuanwu', file), 'utf8'),
        await readFile(join(root, 'skills/xuanwu', file), 'utf8'));
    }
    const guide = await readFile(join(target, 'xuanwu/SKILL.md'), 'utf8');
    for (const command of ['xuanwu project list', 'xuanwu node list', 'xuanwu project create', '--node-id', '/api/providers?project_id=']) {
      assert.ok(guide.includes(command), `missing remote command: ${command}`);
    }
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});
