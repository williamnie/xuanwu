import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { BRAND, PRODUCT_TERMS } from './brand.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const UI_ROOTS = [
  resolve(REPO_ROOT, 'frontend/src/components'),
  resolve(REPO_ROOT, 'frontend/src/pages'),
];
const UI_FILES = [
  ...UI_ROOTS.flatMap(collectUiFiles),
  resolve(REPO_ROOT, 'frontend/index.html'),
];
const FORBIDDEN_UI_TERMS = [
  'PI Assistant',
  'Runner Brain',
  'PI Supervisor',
  'PI Guardian',
  'PI Memory',
  'PI OAuth',
  'Agent Guardian',
  'Codex Issue Runner',
  'Local issue loop guardian',
];

test('canonical product, Supervisor, and Runner terms stay fixed', () => {
  assert.deepEqual(PRODUCT_TERMS, {
    product: '玄武',
    productLatin: 'Xuanwu',
    supervisor: 'Xuanwu Supervisor',
    supervisorShort: 'Supervisor',
    runner: 'Runner',
    compatibilityId: 'codex-issue-runner',
  });
  assert.equal(BRAND.name, PRODUCT_TERMS.productLatin);
  assert.equal(BRAND.hanzi, PRODUCT_TERMS.product);
  assert.equal(BRAND.descriptor, 'AI Engineering Control Plane');
  assert.equal(BRAND.tagline, 'Local-first · Verification-first');

  const contract = source('docs/architecture/xuanwu/0002-brand-terminology.md');
  assert.match(contract, /canonical 级别：本文件是玄武品牌术语的 source of truth/);
  assert.match(contract, /双写：无/);
  assert.match(contract, /双读：无/);
  assert.match(contract, /最多保留本 ADR 生效后的两个正式 release/);
});

test('live UI source does not expose legacy product identities', () => {
  const violations = [];
  for (const file of UI_FILES) {
    const repoPath = relative(REPO_ROOT, file);
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const term of FORBIDDEN_UI_TERMS) {
        if (line.includes(term) && !isLegacyProjectionLiteral(repoPath, line)) {
          violations.push(`${repoPath}:${index + 1}: ${term}`);
        }
      }
    });
  }
  assert.deepEqual(violations, []);
});

test('CLI, API, and DB compatibility identifiers stay unchanged', () => {
  assert.match(source('backend-ts/src/db/defaultPiAgent.ts'), /DEFAULT_PI_AGENT_ID = "runner-default"/);
  assert.match(source('backend-ts/src/db/defaultPiAgent.ts'), /DEFAULT_PI_AGENT_NAME = "Xuanwu Supervisor"/);
  assert.match(source('backend-ts/src/db/schema/003_pi_runtime.ts'), /create table if not exists pi_agents/);
  assert.match(source('backend-ts/src/db/schema/003_pi_runtime.ts'), /pi_agent_id text not null/);
  assert.match(source('backend-ts/src/http/piApi.ts'), /router\.get\("\/api\/pi\/agents"/);
  assert.match(source('backend-ts/src/providers/codex/adapter.ts'), /name: "codex-issue-runner"/);
  assert.match(source('backend-ts/scripts/build-binary.sh'), /dist\/codex-issue-runner/);
});

function collectUiFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return collectUiFiles(path);
    if (!/\.(?:js|jsx)$/.test(entry.name) || entry.name.endsWith('.test.js')) return [];
    return [path];
  });
}

function isLegacyProjectionLiteral(repoPath, line) {
  if (repoPath !== 'frontend/src/pages/piAgentSettingsState.js') return false;
  return new Set([
    "'你是全局 PI Assistant runtime，负责观察所有项目、调度 sessions/issues、提出 action 建议并沉淀记忆。',",
    "'你是全局 Runner Brain，负责观察所有项目、调度 sessions/issues、提出 action 建议并沉淀记忆。',",
    "const LEGACY_PI_AGENT_NAMES = new Set(['PI Assistant', 'Runner Agent', 'Runner Brain']);",
  ]).has(line.trim());
}

function source(path) {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}
