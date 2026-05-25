import assert from 'node:assert/strict';
import test from 'node:test';

import { holdReasonLabel, splitHoldText } from './projectHold.js';

test('project hold helper maps known hold reasons to short labels', () => {
  assert.equal(holdReasonLabel('usage_limit'), '用量/限额');
  assert.equal(holdReasonLabel('authentication'), '认证失败');
});

test('project hold helper collapses long self check errors', () => {
  const text = `first line\n${'x'.repeat(160)}`;
  const result = splitHoldText(text, 40);

  assert.equal(result.collapsed, true);
  assert.match(result.summary, /…$/);
  assert.equal(result.full, text);
});
