#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = parseArgs(process.argv.slice(2));
const version = required(options.version, '--version');
if (!/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`release version must be a semantic v* tag, got ${version}`);
}
if (options.requireChangelog) {
  const changelog = await readFile(resolve(root, 'CHANGELOG.md'), 'utf8');
  const heading = `## [${version.slice(1)}]`;
  if (!changelog.split(/\r?\n/).some(line => line.trim() === heading || line.trim().startsWith(`${heading} `))) {
    throw new Error(`CHANGELOG.md is missing ${heading}`);
  }
}

const targets = options.targets.map(target => ({
  asset: assetName(target),
  target,
}));
if (targets.length === 0) throw new Error('at least one --target is required');

const backendPackage = JSON.parse(await readFile(resolve(root, 'backend-ts/package.json'), 'utf8'));
const qoderCliVersion = backendPackage.dependencies['@qoder-ai/qodercli'];
if (!/^\d+\.\d+\.\d+$/.test(qoderCliVersion || '')) throw new Error('Qoder CLI must use an exact pinned version');

const manifest = {
  schema_version: 'xuanwu.release.v1',
  version,
  revision: required(options.revision, '--revision'),
  build_stamp: required(options.buildStamp, '--build-stamp'),
  generated_at: new Date().toISOString(),
  source_of_truth: 'runner.db',
  storage_compatibility: 'xuanwu.storage-compat.v1',
  qoder_cli_version: qoderCliVersion,
  migration_notes: 'docs/runbooks/release-upgrade-rollback.md#migration-notes',
  rollback: 'Restore release-owned files from a release snapshot; restore runner.db only from a separately verified backup when migrations require it.',
  targets,
};

await writeFile(required(options.output, '--output'), `${JSON.stringify(manifest, null, 2)}\n`);

function parseArgs(args) {
  const result = { buildStamp: '', output: '', requireChangelog: false, revision: '', targets: [], version: '' };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--require-changelog') result.requireChangelog = true;
    else if (arg === '--target') result.targets.push(required(args[++index], arg));
    else if (arg === '--version') result.version = required(args[++index], arg);
    else if (arg === '--revision') result.revision = required(args[++index], arg);
    else if (arg === '--build-stamp') result.buildStamp = required(args[++index], arg);
    else if (arg === '--output') result.output = required(args[++index], arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return result;
}

function required(value, label) {
  const clean = `${value || ''}`.trim();
  if (!clean) throw new Error(`${label} requires a value`);
  return clean;
}

function assetName(target) {
  const mapping = {
    'bun-darwin-arm64': 'xuanwu_darwin_arm64.tar.gz',
    'bun-darwin-x64': 'xuanwu_darwin_amd64.tar.gz',
    'bun-linux-arm64': 'xuanwu_linux_arm64.tar.gz',
    'bun-linux-x64': 'xuanwu_linux_amd64.tar.gz',
  };
  if (!mapping[target]) throw new Error(`unsupported target: ${target}`);
  return mapping[target];
}
