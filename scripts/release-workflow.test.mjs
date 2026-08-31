import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;

test('CI, package, and Release all invoke the canonical repository hygiene authority', async () => {
  const [ci, release, packaging] = await Promise.all([
    readFile(join(root, '.github', 'workflows', 'ci.yml'), 'utf8'),
    readFile(join(root, '.github', 'workflows', 'release.yml'), 'utf8'),
    readFile(join(root, 'scripts', 'package-release.sh'), 'utf8'),
  ]);
  const command = 'node scripts/repository-hygiene-audit.mjs';
  assert.ok(ci.includes(command));
  assert.ok(release.includes(command));
  assert.ok(packaging.includes('node "$ROOT_DIR/scripts/repository-hygiene-audit.mjs"'));
});

test('pull request and main CI is read-only, frozen, and runs every required gate', async () => {
  const workflow = await readFile(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /push:\n\s+branches:\n\s+- main/);
  assert.match(workflow, /permissions:\n\s+contents: read/);
  assert.doesNotMatch(workflow, /contents: write|packages: write|id-token: write|gh release/);
  assert.match(workflow, /bun install --cwd backend-ts --frozen-lockfile --ignore-scripts/);
  assert.match(workflow, /npm --prefix frontend ci --ignore-scripts/);
  for (const gate of [
    'bun test --timeout 60000',
    'node --test scripts/*.test.mjs',
    'npm --prefix frontend run lint',
    'npm --prefix frontend run build',
    'node scripts/repository-hygiene-audit.mjs',
    'node scripts/dependency-security-audit.mjs',
    'git diff --check'
  ]) assert.ok(workflow.includes(gate), `CI is missing ${gate}`);
});
