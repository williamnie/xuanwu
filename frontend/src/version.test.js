import assert from 'node:assert/strict';
import test from 'node:test';

import { FALLBACK_APP_VERSION, buildVersionSummary, resolveAppVersion } from './version.js';

test('resolveAppVersion falls back to injected fallback version when release version is missing', () => {
  assert.equal(resolveAppVersion(undefined, 'v0.1.0-430-g576359f-dirty'), 'v0.1.0-430-g576359f-dirty');
  assert.equal(resolveAppVersion('   ', 'v0.1.0-430-g576359f-dirty'), 'v0.1.0-430-g576359f-dirty');
});

test('resolveAppVersion only uses unknown fallback when no version source is available', () => {
  assert.equal(resolveAppVersion(undefined), FALLBACK_APP_VERSION);
});

test('resolveAppVersion preserves injected release tag', () => {
  assert.equal(resolveAppVersion('v0.1.2'), 'v0.1.2');
});

test('buildVersionSummary stays quiet for matching release versions and stamps', () => {
  const summary = buildVersionSummary('v0.1.2', {
    service: { version: 'v0.1.2', build: { stamp: 'stamp-a', dist_stamp_status: 'match' } },
  });

  assert.equal(summary.ok, true);
  assert.deepEqual(summary.warnings, []);
  assert.equal(summary.backendVersion, 'v0.1.2');
  assert.equal(summary.distStampStatus, 'match');
});

test('buildVersionSummary does not warn for matching git-derived versions', () => {
  const gitVersion = 'v0.1.0-430-g576359f-dirty';
  const summary = buildVersionSummary(gitVersion, {
    service: { version: gitVersion, build: { stamp: 'stamp-a', dist_stamp_status: 'match' } },
  });

  assert.equal(summary.ok, true);
  assert.deepEqual(summary.warnings, []);
  assert.equal(summary.frontendVersion, gitVersion);
  assert.equal(summary.backendVersion, gitVersion);
});

test('buildVersionSummary warns for version mismatch and bad stamp', () => {
  const summary = buildVersionSummary('v0.1.3', {
    service: { version: 'v0.1.2', build: { dist_stamp_status: 'mismatch' } },
  });

  assert.equal(summary.ok, false);
  assert.match(summary.warnings.join('\n'), /Frontend v0\.1\.3 与 Backend v0\.1\.2 不一致/);
  assert.match(summary.warnings.join('\n'), /Build stamp 状态异常: mismatch/);
});
