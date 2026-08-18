#!/usr/bin/env node

import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = parseArgs(process.argv.slice(2));
const output = resolve(options.output);
const policy = JSON.parse(await readFile(join(root, 'third_party', 'release-redistribution-policy.json'), 'utf8'));

await rm(output, { recursive: true, force: true });
await mkdir(join(output, 'third-party-licenses'), { recursive: true });

const backend = await backendComponents();
const frontend = await frontendComponents();
const components = [...backend, ...frontend].sort(compareComponents);
const blocked = policy.components.filter((component) => component.redistribution_status === 'requires-legal-review');
const missingLicenseFiles = [];

await cp(
  join(root, 'third_party', 'licenses', 'pi-mono-MIT.txt'),
  join(output, 'third-party-licenses', 'pi-mono-MIT.txt')
);
await cp(
  join(root, 'third_party', 'licenses', 'node-ignore-MIT.txt'),
  join(output, 'third-party-licenses', 'node-ignore-MIT.txt')
);
await cp(
  join(root, 'backend-ts', 'node_modules', '@qoder-ai', 'qodercli', 'LICENSE'),
  join(output, 'third-party-licenses', 'Apache-2.0.txt')
);

for (const component of components) {
  component.license_files = await stageLicenseFiles(component, missingLicenseFiles);
}

await writeFile(join(output, 'sbom.cdx.json'), `${JSON.stringify(cycloneDx(components), null, 2)}\n`);
await writeFile(join(output, 'THIRD_PARTY_NOTICES.md'), notices(components, blocked, missingLicenseFiles));
await writeFile(join(output, 'bundled-components.json'), `${JSON.stringify(bundleInventory(components), null, 2)}\n`);
await writeFile(join(output, 'legal-review.json'), `${JSON.stringify({
  schema_version: 1,
  release_ready: blocked.length === 0 && missingLicenseFiles.length === 0,
  blocked_components: blocked,
  missing_package_license_files: missingLicenseFiles
}, null, 2)}\n`);

console.log(`[compliance] wrote ${components.length} components to ${relative(root, output) || '.'}`);
if (blocked.length > 0) {
  console.error(`[compliance] redistribution requires legal confirmation: ${blocked.map((item) => item.package).join(', ')}`);
  if (options.enforceRedistribution) process.exitCode = 1;
}

async function backendComponents() {
  const project = join(root, 'backend-ts');
  const manifest = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
  const pending = Object.keys(manifest.dependencies ?? {}).map((name) => ({ name, from: project, direct: true, optional: false }));
  const seen = new Map();
  while (pending.length > 0) {
    const item = pending.pop();
    const manifestPath = await resolvePackageManifest(project, item.from, item.name);
    if (!manifestPath && item.optional) continue;
    if (!manifestPath) throw new Error(`installed backend dependency is missing: ${item.name} (from ${item.from})`);
    const packageManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const key = `${packageManifest.name}@${packageManifest.version}`;
    const current = seen.get(key);
    if (current) {
      current.direct ||= item.direct;
      continue;
    }
    const packageDir = dirname(manifestPath);
    const component = npmComponent('backend', packageManifest, packageDir, item.direct);
    seen.set(key, component);
    for (const dependency of Object.keys(packageManifest.dependencies ?? {})) {
      pending.push({ name: dependency, from: packageDir, direct: false, optional: false });
    }
  }
  return [...seen.values()];
}

async function frontendComponents() {
  const project = join(root, 'frontend');
  const lock = JSON.parse(await readFile(join(project, 'package-lock.json'), 'utf8'));
  const direct = new Set(Object.keys(lock.packages?.['']?.dependencies ?? {}));
  const components = [];
  for (const [lockPath, entry] of Object.entries(lock.packages ?? {})) {
    if (!lockPath || entry.dev === true || !entry.version || !lockPath.includes('node_modules/')) continue;
    const name = entry.name ?? packageNameFromLockPath(lockPath);
    const packageDir = join(project, lockPath);
    const manifestPath = join(packageDir, 'package.json');
    if (!existsSync(manifestPath)) throw new Error(`installed frontend dependency is missing: ${lockPath}`);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    components.push(npmComponent('frontend', { ...manifest, name, version: entry.version }, packageDir, direct.has(name)));
  }
  return uniqueComponents(components);
}

async function resolvePackageManifest(project, from, name) {
  let current = resolve(from);
  while (current.startsWith(project)) {
    const candidate = join(current, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return realpath(candidate);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const fallback = join(project, 'node_modules', name, 'package.json');
  return existsSync(fallback) ? realpath(fallback) : null;
}

function npmComponent(ecosystem, manifest, packageDir, direct) {
  const license = typeof manifest.license === 'string' ? manifest.license : 'NOASSERTION';
  return {
    ecosystem,
    name: manifest.name,
    version: manifest.version,
    package_dir: packageDir,
    direct,
    license,
    repository: repositoryUrl(manifest.repository),
    homepage: manifest.homepage ?? '',
    purl: `pkg:npm/${manifest.name.replace(/^@/, '%40')}@${manifest.version}`
  };
}

async function stageLicenseFiles(component, missing) {
  const names = (await readdir(component.package_dir)).filter((name) => /^(?:licen[cs]e|copying|notice|copyright)(?:\.|$)/i.test(name));
  if (names.length === 0) {
    if (component.name.startsWith('@earendil-works/pi-') && component.license === 'MIT') {
      return ['third-party-licenses/pi-mono-MIT.txt'];
    }
    if (component.name === 'ignore' && component.license === 'MIT') {
      return ['third-party-licenses/node-ignore-MIT.txt'];
    }
    if (component.license === 'Apache-2.0') {
      return ['third-party-licenses/Apache-2.0.txt'];
    }
    missing.push({ ecosystem: component.ecosystem, name: component.name, version: component.version, declared_license: component.license });
    return [];
  }
  const targetDir = join(output, 'third-party-licenses', component.ecosystem, slug(`${component.name}@${component.version}`));
  await mkdir(targetDir, { recursive: true });
  const staged = [];
  for (const name of names.sort()) {
    const source = join(component.package_dir, name);
    const target = join(targetDir, name);
    await cp(source, target, { recursive: true });
    staged.push(relative(output, target).split('\\').join('/'));
  }
  return staged;
}

function cycloneDx(components) {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: { type: 'application', name: 'Xuanwu release archive', version: process.env.XUANWU_VERSION || 'unreleased' },
      properties: [
        { name: 'xuanwu:backend-scope', value: 'installed production dependency graph compiled into or supporting the backend payload; adjacent payloads are inventoried separately' },
        { name: 'xuanwu:frontend-scope', value: 'package-lock production dependency set used to build the archived web assets' }
      ]
    },
    components: components.map((component) => ({
      type: 'library',
      'bom-ref': `${component.ecosystem}:${component.purl}`,
      name: component.name,
      version: component.version,
      purl: component.purl,
      licenses: [{ ...(isSpdxExpression(component.license) ? { expression: component.license } : { name: component.license }) }],
      properties: [
        { name: 'xuanwu:ecosystem', value: component.ecosystem },
        { name: 'xuanwu:direct-dependency', value: String(component.direct) },
        { name: 'xuanwu:license-files', value: component.license_files.join(',') || 'not-present-in-installed-package' }
      ],
      ...(component.repository || component.homepage ? { externalReferences: [
        ...(component.repository ? [{ type: 'vcs', url: component.repository }] : []),
        ...(component.homepage ? [{ type: 'website', url: component.homepage }] : [])
      ] } : {})
    }))
  };
}

function bundleInventory(components) {
  const selected = (name) => components.filter((component) => component.name === name).map(({ ecosystem, name: packageName, version, license }) => ({ ecosystem, package: packageName, version, license }));
  return {
    schema_version: 1,
    scopes: {
      backend_binary: 'backend production dependency graph',
      web: 'frontend package-lock production dependency set',
      adjacent_payloads: [
        { path: 'package.json, theme/, assets/, export-html/, examples/, docs/pi-coding-agent/, photon_rs_bg.wasm, xuanwu.pi-policy-extension.ts', components: selected('@earendil-works/pi-coding-agent') },
        { path: 'xuanwu.claude-agent-sdk', components: selected('@anthropic-ai/claude-agent-sdk') },
        { path: 'xuanwu.qodercli/', components: selected('@qoder-ai/qodercli') }
      ]
    },
    policy_components: policy.components.map((item) => ({ ...item, resolved: selected(item.package) }))
  };
}

function notices(components, blocked, missing) {
  const policyRows = policy.components.map((item) => `| ${item.package} | ${item.redistribution_status} | ${item.reason} |`).join('\n');
  const componentRows = components.map((item) => `| ${item.ecosystem} | ${item.name} | ${item.version} | ${item.license} | ${item.license_files.join('<br>') || 'not present in installed package'} |`).join('\n');
  return `# Third-party notices for the Xuanwu release archive

This generated inventory is evidence for release review, not a legal opinion. It does not claim rights beyond the cited package files and upstream terms.

## Redistribution gate

Release ready: **${blocked.length === 0 && missing.length === 0 ? 'yes' : 'no'}**

| Component | Status | Evidence-based conclusion |
| --- | --- | --- |
${policyRows}

${blocked.length === 0 ? '' : `The release is fail-closed until an authorized legal reviewer records explicit redistribution approval for: ${blocked.map((item) => item.package).join(', ')}.\n`}
${missing.length === 0 ? '' : `The release is also fail-closed until authoritative license texts are supplied for every package listed below.\n`}
## Bundled dependency inventory

The CycloneDX SBOM in \`sbom.cdx.json\` is authoritative for the generated component set. Detected package license and notice files are copied under \`third-party-licenses/\`.

| Scope | Package | Version | Declared license | Included license files |
| --- | --- | --- | --- | --- |
${componentRows}

## Packages without a root license file

${missing.length === 0 ? 'None.\n' : `${missing.map((item) => `- ${item.ecosystem}: ${item.name}@${item.version} (declared ${item.declared_license})`).join('\n')}\n`}
The absence of a root license file is recorded rather than silently converted into a redistribution claim. The Pi monorepo MIT text is included separately because Pi npm packages declare MIT but omit the monorepo root license.
`;
}

function parseArgs(args) {
  const result = { output: '', enforceRedistribution: false };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--output') result.output = args[++index] ?? '';
    else if (args[index] === '--enforce-redistribution') result.enforceRedistribution = true;
    else throw new Error(`unknown argument: ${args[index]}`);
  }
  if (!result.output) throw new Error('--output is required');
  return result;
}

function packageNameFromLockPath(lockPath) {
  const tail = lockPath.slice(lockPath.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const parts = tail.split('/');
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

function uniqueComponents(components) {
  return [...new Map(components.map((component) => [`${component.ecosystem}:${component.name}@${component.version}`, component])).values()];
}

function compareComponents(left, right) {
  return `${left.ecosystem}:${left.name}@${left.version}`.localeCompare(`${right.ecosystem}:${right.name}@${right.version}`);
}

function repositoryUrl(value) {
  if (typeof value === 'string') return value.replace(/^git\+/, '').replace(/\.git$/, '');
  if (value && typeof value.url === 'string') return value.url.replace(/^git\+/, '').replace(/\.git$/, '');
  return '';
}

function isSpdxExpression(value) {
  return value !== 'NOASSERTION' && !/^SEE LICENSE/i.test(value);
}

function slug(value) {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_');
}
