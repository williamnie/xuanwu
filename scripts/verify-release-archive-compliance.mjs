#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const archive = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('usage: verify-release-archive-compliance.mjs <release-archive.tar.gz>');

const entries = command(['-tzf', archive]).split('\n').filter(Boolean);
for (const path of [
  'compliance/THIRD_PARTY_NOTICES.md',
  'compliance/sbom.cdx.json',
  'compliance/bundled-components.json',
  'compliance/legal-review.json',
  'compliance/third-party-licenses/pi-mono-MIT.txt'
]) {
  assert(entries.some((entry) => normalize(entry) === path), `release archive is missing ${path}`);
}

const sbom = JSON.parse(command(['-xOzf', archive, archivePath('compliance/sbom.cdx.json')]));
const review = JSON.parse(command(['-xOzf', archive, archivePath('compliance/legal-review.json')]));
assert(sbom.bomFormat === 'CycloneDX' && sbom.components.length > 0, 'archived SBOM is invalid');
assert(review.release_ready === true, 'archived legal review does not authorize release');
console.log(`[compliance] verified archived SBOM with ${sbom.components.length} components`);

function command(args) {
  const result = spawnSync('tar', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `tar ${args.join(' ')} failed`);
  return result.stdout;
}

function archivePath(path) {
  return entries.find((entry) => normalize(entry) === path) ?? path;
}

function normalize(path) {
  return path.replace(/^\.\//, '');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
