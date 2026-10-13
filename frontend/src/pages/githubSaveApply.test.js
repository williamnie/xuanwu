import assert from 'node:assert/strict';
import test from 'node:test';

import { canRetryApply, classifyApplyError, resolveUncertainApply } from './githubSaveApply.js';

test('apply failures are told apart by the backend error code', () => {
  assert.equal(classifyApplyError({ status: 409, message: 'config_conflict：设置已被修改' }), 'config_conflict');
  assert.equal(classifyApplyError({ status: 409, message: 'reload_failed：配置已保存但未应用' }), 'reload_failed');
  assert.equal(classifyApplyError({ status: 503, message: 'runtime_unavailable：配置已保存' }), 'runtime_unavailable');
  assert.equal(classifyApplyError(new TypeError('Failed to fetch')), 'unconfirmed');
  assert.equal(classifyApplyError({ status: 500, message: 'settings_io_failed' }), 'failed');
});

test('an unconfirmed apply only counts as applied when the saved revision is still ours', () => {
  assert.equal(resolveUncertainApply({ revision: 'r1', application: { status: 'applied' } }, 'r1'), 'applied');
  assert.equal(resolveUncertainApply({ revision: 'r1', application: { status: 'pending' } }, 'r1'), 'unconfirmed');
  assert.equal(resolveUncertainApply({ revision: 'r2', application: { status: 'applied' } }, 'r1'), 'config_conflict');
  assert.equal(resolveUncertainApply(null, 'r1'), 'config_conflict');
});

test('retrying apply requires the saved version to be current and the draft unchanged', () => {
  const remote = { revision: 'r1', application: { status: 'pending' } };
  assert.equal(canRetryApply({ remote, savedRevision: 'r1', conflict: false }, false), true);
  assert.equal(canRetryApply({ remote, savedRevision: 'r1', conflict: false }, true), false);
  assert.equal(canRetryApply({ remote, savedRevision: 'r0', conflict: false }, false), false);
  assert.equal(canRetryApply({ remote, savedRevision: 'r1', conflict: true }, false), false);
  assert.equal(canRetryApply({ remote: { ...remote, application: { status: 'applied' } }, savedRevision: 'r1', conflict: false }, false), false);
});
