#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const backendGraphRootArgument = process.argv.indexOf('--backend-graph-root');
const backendGraphRoot = backendGraphRootArgument >= 0 ? process.argv[backendGraphRootArgument + 1] : '';
if (backendGraphRootArgument >= 0 && !backendGraphRoot) throw new Error('--backend-graph-root requires a path');
const root = backendGraphRoot
  ? resolve(backendGraphRoot)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const checks = [];

const backendProductionRoots = backendGraphRoot ? [
  {
    path: 'backend-ts/src/main.ts',
    owner: 'fixture-runtime',
    purpose: 'fixture service entrypoint',
    invocation: 'bun run backend-ts/src/main.ts',
    test: 'backend-ts/src/main.test.ts',
  },
] : [
  {
    path: 'backend-ts/src/main.ts',
    owner: 'runtime',
    purpose: 'service entrypoint',
    invocation: 'xuanwu serve',
    test: 'backend-ts/src/mainWiring.test.ts',
  },
  {
    path: 'backend-ts/src/providers/pi/xuanwuPolicyExtension.ts',
    owner: 'release-package',
    purpose: 'Pi policy extension staged beside packaged binary',
    invocation: 'scripts/package-release.sh:stage_pi_policy_extension',
    test: 'backend-ts/src/providers/pi/provider.test.ts',
  },
  {
    path: 'backend-ts/src/spikes/piSmoke.ts',
    owner: 'provider-smoke',
    purpose: 'standalone Pi provider smoke executable',
    invocation: 'bun run backend-ts/src/spikes/piSmoke.ts',
    test: 'backend-ts/src/spikes/piSmokeSupport.test.ts',
  },
  {
    path: 'backend-ts/src/usage/benchmark.ts',
    owner: 'usage-observability',
    purpose: 'standalone provider usage benchmark executable',
    invocation: 'bun run backend-ts/src/usage/benchmark.ts',
    test: 'backend-ts/src/usage/providers.test.ts',
  },
];

if (backendGraphRoot) {
  check('backend source reference graph has zero unclassified orphans', unreachableBackendFiles());
  printReportAndExit();
  process.exit(process.exitCode ?? 1);
}

const retiredPaths = [
  'frontend/src/api/client.js',
  'frontend/src/api/index.js',
  'frontend/src/components/IssueWorkflowEvidencePanel.js',
  'frontend/src/utils/issueWorkflowEvidence.js',
  'frontend/src/utils/issueWorkflowSnapshot.js',
  'frontend/src/pages/AutomationsRuntimePanel.jsx',
  'frontend/src/pages/Cron.jsx',
  'frontend/src/pages/sessions/SessionCreateModal.jsx',
  'frontend/src/pages/sessions/SessionCreateModal.css',
  'frontend/src/pages/sessions/sessionComposerHelp.js',
];

check('retired production paths are absent', retiredPaths.filter((path) => existsSync(join(root, path))));

const frontendOrphans = unreachableRuntimeFiles('frontend/src', 'main.jsx', new Set(['.js', '.jsx', '.css']));
check('frontend production import graph has zero orphans', frontendOrphans);

const backendOrphans = unreachableBackendFiles();
check('backend source reference graph has zero unclassified orphans', backendOrphans);

const trackedArtifacts = trackedFiles().filter(isRuntimeArtifact);
check('tracked runtime/build artifact set is empty', trackedArtifacts);

const productionSources = sourceFiles(['frontend/src', 'backend-ts/src'], new Set(['.js', '.jsx', '.ts', '.css']))
  .filter((path) => !isTestFile(path));
const retiredSymbols = [
  'IssueWorkflowEvidencePanel',
  'deriveIssueWorkflowEvidence',
  'SessionCreateModal',
  'AutomationsRuntimePanel',
  "from './api/client.js'",
  "from './api/index.js'",
];
const staleSymbols = [];
for (const path of productionSources) {
  const source = readFileSync(path, 'utf8');
  for (const symbol of retiredSymbols) {
    if (source.includes(symbol)) staleSymbols.push(`${repoPath(path)}: ${symbol}`);
  }
}
check('retired exports and components have zero production references', staleSymbols);

const staleCss = [];
for (const path of sourceFiles(['frontend/src'], new Set(['.css']))) {
  const source = readFileSync(path, 'utf8');
  for (const selector of ['.issue-workflow-', '.session-create-', '.cron-page']) {
    if (source.includes(selector)) staleCss.push(`${repoPath(path)}: ${selector}`);
  }
}
check('retired CSS selector families have zero definitions', staleCss);

for (const entry of ['/output/', '/dist/', '/build/', 'frontend/dist/', '/data/', 'backend-ts/data-bun/', '.runner/']) {
  if (!readFileSync(join(root, '.gitignore'), 'utf8').includes(entry)) {
    failures.push(`.gitignore missing ${entry}`);
  }
}
checks.push({ check: 'gitignore covers repository runtime outputs', findings: failures.filter((item) => item.startsWith('.gitignore ')).length });

const report = { ok: failures.length === 0, checks, failures };
printReportAndExit(report);

function printReportAndExit(value = { ok: failures.length === 0, checks, failures }) {
  if (process.argv.includes('--json')) console.log(JSON.stringify(value, null, 2));
  else {
    for (const item of value.checks) console.log(`[${item.findings === 0 ? 'ok' : 'fail'}] ${item.check}`);
    for (const failure of value.failures) console.error(`  - ${failure}`);
  }
  process.exitCode = value.ok ? 0 : 1;
}

function check(name, findings) {
  checks.push({ check: name, findings: findings.length });
  failures.push(...findings.map((finding) => `${name}: ${finding}`));
}

function unreachableRuntimeFiles(directory, entry, extensions) {
  const base = join(root, directory);
  const files = sourceFiles([directory], extensions).filter((path) => !isTestFile(path));
  const candidates = new Set(files.map((path) => resolve(path)));
  const seen = new Set();
  const pending = [resolve(base, entry)];
  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || seen.has(path) || !candidates.has(path)) continue;
    seen.add(path);
    if (extname(path) === '.css') continue;
    for (const specifier of importSpecifiers(readFileSync(path, 'utf8'))) {
      const dependency = resolveImport(path, specifier, extensions);
      if (dependency && candidates.has(dependency)) pending.push(dependency);
    }
  }
  return [...candidates].filter((path) => !seen.has(path)).map(repoPath).sort();
}

function unreachableBackendFiles() {
  const extensions = new Set(['.ts', '.js', '.mjs']);
  const backendFiles = sourceFiles(['backend-ts/src'], extensions);
  const scriptFiles = sourceFiles(['scripts'], extensions);
  const candidates = new Set([...backendFiles, ...scriptFiles].map((path) => resolve(path)));
  const rootMetadataFailures = invalidBackendRootMetadata();
  check('backend production root metadata is complete', rootMetadataFailures);
  const pending = [
    ...backendProductionRoots.map((entry) => resolve(root, entry.path)),
    ...backendFiles.filter(isTestFile),
    ...scriptFiles,
  ];
  const seen = new Set();
  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || seen.has(path) || !candidates.has(path)) continue;
    seen.add(path);
    for (const specifier of importSpecifiers(readFileSync(path, 'utf8'))) {
      const dependency = resolveImport(path, specifier, extensions);
      if (dependency && candidates.has(dependency)) pending.push(dependency);
    }
  }
  return backendFiles
    .filter((path) => !isTestFile(path) && !seen.has(resolve(path)))
    .map(repoPath)
    .sort();
}

function invalidBackendRootMetadata() {
  const required = ['path', 'owner', 'purpose', 'invocation', 'test'];
  const findings = [];
  for (const entry of backendProductionRoots) {
    for (const field of required) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
        findings.push(`${entry.path || '<missing path>'}: missing ${field}`);
      }
    }
    if (entry.path && !existsSync(join(root, entry.path))) findings.push(`${entry.path}: root does not exist`);
    if (entry.test && !existsSync(join(root, entry.test))) findings.push(`${entry.path}: test does not exist: ${entry.test}`);
  }
  return findings;
}

function importSpecifiers(source) {
  const pattern = /(?:import|export)\s+(?:[^'"()]*?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  return [...source.matchAll(pattern)].map((match) => match[1] || match[2] || match[3]);
}

function resolveImport(importer, specifier, extensions) {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(importer), specifier);
  const candidates = [base];
  for (const extension of extensions) candidates.push(`${base}${extension}`);
  for (const extension of extensions) candidates.push(join(base, `index${extension}`));
  return candidates.find((path) => existsSync(path) && statSync(path).isFile()) || null;
}

function sourceFiles(directories, extensions) {
  return directories.flatMap((directory) => walk(join(root, directory)))
    .filter((path) => extensions.has(extname(path)));
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function isTestFile(path) {
  return /\.(?:test|spec|type-test)\.[^.]+$/.test(path) || path.includes(`${join('', '__snapshots__')}`);
}

function trackedFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'git ls-files failed');
  return result.stdout.split('\0').filter((path) => path && existsSync(join(root, path)));
}

function isRuntimeArtifact(path) {
  if (path === 'data-bun/.gitignore') return false;
  return /^(?:dist|build|output|coverage|data|logs?|\.runner|\.playwright-cli)(?:\/|$)/.test(path)
    || /^(?:frontend\/dist|backend-ts\/data-bun)(?:\/|$)/.test(path)
    || /(?:^|\/)node_modules(?:\/|$)/.test(path)
    || /(?:\.db(?:-.+)?|\.log|\.tmp|\.bak)$/.test(path);
}

function repoPath(path) {
  return relative(root, path).split('\\').join('/');
}
