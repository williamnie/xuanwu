#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const policy = JSON.parse(await readFile(join(root, 'security', 'dependency-audit-policy.json'), 'utf8'));
const backend = jsonCommand('bun', ['audit', '--json'], join(root, 'backend-ts'));
const frontend = jsonCommand('npm', ['audit', '--json'], join(root, 'frontend'));

const allowed = new Map(policy.backend_allowed_advisories.map((item) => [`${item.package}:${item.advisory}`, item]));
const observed = new Map();
for (const [packageName, advisories] of Object.entries(backend)) {
  for (const advisory of advisories) {
    const ghsa = advisory.url?.match(/GHSA-[A-Za-z0-9-]+/)?.[0] ?? `id-${advisory.id}`;
    observed.set(`${packageName}:${ghsa}`, { packageName, ghsa, advisory });
  }
}

const unexpected = [...observed].filter(([key]) => !allowed.has(key));
const stale = [...allowed].filter(([key]) => !observed.has(key));
if (unexpected.length > 0) {
  for (const [, item] of unexpected) console.error(`[audit] unexpected backend advisory: ${item.packageName} ${item.ghsa} (${item.advisory.severity})`);
  process.exitCode = 1;
}
if (stale.length > 0) {
  for (const [, item] of stale) console.error(`[audit] stale allowlist entry must be removed: ${item.package} ${item.advisory}`);
  process.exitCode = 1;
}

const qoder = JSON.parse(await readFile(join(root, 'backend-ts', 'node_modules', '@qoder-ai', 'qodercli', 'package.json'), 'utf8'));
const qoderSdk = JSON.parse(await readFile(join(root, 'backend-ts', 'node_modules', '@qoder-ai', 'qoder-agent-sdk', 'package.json'), 'utf8'));
const sharp = JSON.parse(await readFile(join(root, 'backend-ts', 'node_modules', 'sharp', 'package.json'), 'utf8'));
assert(qoder.version === qoderSdk.qoderCliVersion, `Qoder SDK ${qoderSdk.version} requires CLI ${qoderSdk.qoderCliVersion}, installed ${qoder.version}`);
assert(qoder.dependencies?.sharp === '^0.34.5', `Qoder CLI sharp constraint changed: ${qoder.dependencies?.sharp ?? 'missing'}`);
assert(sharp.version === '0.34.5', `allowed sharp version changed: ${sharp.version}`);
assert(Object.keys(frontend.vulnerabilities ?? {}).length === 0, 'frontend npm audit reported vulnerabilities');

for (const item of policy.backend_allowed_advisories) {
  console.warn(`[audit] allowed upstream residual: ${item.package} ${item.advisory}; path=${item.required_path}; ${item.reason}`);
}
if (!process.exitCode) console.log(`[audit] passed with ${allowed.size} documented backend residual and zero frontend vulnerabilities`);

function jsonCommand(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  const output = result.stdout ?? '';
  const start = output.indexOf('{');
  if (start < 0) throw new Error(`${command} ${args.join(' ')} did not return JSON:\n${output}`);
  try {
    return JSON.parse(output.slice(start));
  } catch (error) {
    throw new Error(`${command} ${args.join(' ')} returned invalid JSON: ${error.message}\n${output}\n${result.stderr ?? ''}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    console.error(`[audit] ${message}`);
    process.exitCode = 1;
  }
}
