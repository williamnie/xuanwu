import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;

test('release compliance generates reviewable SBOM and fails closed on unconfirmed redistribution', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'xuanwu-release-compliance-'));
  try {
    const output = join(temp, 'compliance');
    const generated = run('node', [join(root, 'scripts', 'generate-release-compliance.mjs'), '--output', output]);
    assert.equal(generated.status, 0, generated.stderr);
    const verified = run('node', [join(root, 'scripts', 'verify-release-compliance.mjs'), output]);
    assert.equal(verified.status, 0, verified.stderr);

    const sbom = JSON.parse(await readFile(join(output, 'sbom.cdx.json'), 'utf8'));
    const review = JSON.parse(await readFile(join(output, 'legal-review.json'), 'utf8'));
    assert.equal(sbom.bomFormat, 'CycloneDX');
    assert.ok(sbom.components.some((component) => component.name === '@earendil-works/pi-coding-agent'));
    assert.ok(sbom.components.some((component) => component.name === '@anthropic-ai/claude-agent-sdk'));
    assert.deepEqual(review.blocked_components.map((item) => item.package).sort(), [
      '@anthropic-ai/claude-agent-sdk',
      '@qoder-ai/qoder-agent-sdk'
    ]);

    const enforced = run('node', [join(root, 'scripts', 'verify-release-compliance.mjs'), output, '--require-release-ready']);
    assert.notEqual(enforced.status, 0);
    assert.match(enforced.stderr, /release is blocked by legal\/license review/);

    // Archive validation uses an explicitly synthetic approved fixture; production approval remains blocked.
    await writeFile(join(output, 'legal-review.json'), `${JSON.stringify({
      ...review,
      release_ready: true,
      blocked_components: [],
      missing_package_license_files: []
    }, null, 2)}\n`);
    const archive = join(temp, 'fixture.tar.gz');
    assert.equal(run('tar', ['-czf', archive, '-C', temp, 'compliance']).status, 0);
    const archiveVerified = run('node', [join(root, 'scripts', 'verify-release-archive-compliance.mjs'), archive]);
    assert.equal(archiveVerified.status, 0, archiveVerified.stderr);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('release packaging generates, gates, and validates archived compliance evidence', async () => {
  const script = await readFile(join(root, 'scripts', 'package-release.sh'), 'utf8');
  assert.match(script, /run_step "repository hygiene" node "\$ROOT_DIR\/scripts\/repository-hygiene-audit\.mjs"/);
  assert.match(script, /generate-release-compliance\.mjs/);
  assert.match(script, /verify-release-compliance\.mjs/);
  assert.match(script, /--require-release-ready/);
  assert.match(script, /verify-release-archive-compliance\.mjs/);
});

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

function run(command, args) {
  return spawnSync(command, args, { cwd: root, encoding: 'utf8' });
}
