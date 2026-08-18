#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const directory = resolve(process.argv[2] ?? '');
const requireReleaseReady = process.argv.includes('--require-release-ready');
if (!process.argv[2]) throw new Error('usage: verify-release-compliance.mjs <compliance-directory>');

const sbom = JSON.parse(await readFile(resolve(directory, 'sbom.cdx.json'), 'utf8'));
const inventory = JSON.parse(await readFile(resolve(directory, 'bundled-components.json'), 'utf8'));
const review = JSON.parse(await readFile(resolve(directory, 'legal-review.json'), 'utf8'));
const notice = await readFile(resolve(directory, 'THIRD_PARTY_NOTICES.md'), 'utf8');
const licenseEntries = await readdir(resolve(directory, 'third-party-licenses'));

assert(sbom.bomFormat === 'CycloneDX' && sbom.specVersion === '1.6', 'SBOM must be CycloneDX 1.6');
assert(Array.isArray(sbom.components) && sbom.components.length > 0, 'SBOM component list is empty');
for (const name of ['@anthropic-ai/claude-agent-sdk', '@qoder-ai/qoder-agent-sdk', '@qoder-ai/qodercli', '@earendil-works/pi-coding-agent', 'sharp']) {
  assert(sbom.components.some((component) => component.name === name), `SBOM is missing ${name}`);
}
assert(inventory.scopes?.adjacent_payloads?.length === 3, 'adjacent payload inventory is incomplete');
assert(Array.isArray(review.blocked_components), 'legal review record is invalid');
assert(review.release_ready === (review.blocked_components.length === 0 && review.missing_package_license_files.length === 0), 'release_ready does not match compliance blockers');
assert(notice.includes('does not claim rights beyond'), 'NOTICE must avoid unsupported redistribution claims');
assert(notice.includes('Release ready: **no**') === !review.release_ready, 'NOTICE release status is stale');
assert(licenseEntries.length > 0, 'third-party license directory is empty');
assert(!requireReleaseReady || review.release_ready, `release is blocked by legal/license review: ${[
  ...review.blocked_components.map((item) => item.package),
  ...review.missing_package_license_files.map((item) => `${item.name}@${item.version}`)
].join(', ')}`);

console.log(`[compliance] verified ${sbom.components.length} SBOM components; release_ready=${review.release_ready}`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
