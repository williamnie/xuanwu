import assert from 'node:assert/strict';
import test from 'node:test';

import { FALLBACK_APP_VERSION, resolveAppVersion } from './version.js';

test('resolveAppVersion falls back to dev version when release version is missing', () => {
  assert.equal(resolveAppVersion(undefined), FALLBACK_APP_VERSION);
  assert.equal(resolveAppVersion('   '), FALLBACK_APP_VERSION);
});

test('resolveAppVersion preserves injected release tag', () => {
  assert.equal(resolveAppVersion('v0.1.2'), 'v0.1.2');
});
