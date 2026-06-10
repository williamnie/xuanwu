import assert from 'node:assert/strict';
import test from 'node:test';
import { issueSpeedToggleCopy, isFastIssueSpeed } from './issueSpeedToggle.js';

test('issue speed toggle defaults to normal/off and clicks through to fast', () => {
  const copy = issueSpeedToggleCopy('');

  assert.equal(copy.enabled, false);
  assert.equal(copy.currentLabel, '正常');
  assert.equal(copy.nextLabel, '快速');
  assert.equal(copy.nextServiceTier, 'priority');
  assert.match(copy.ariaLabel, /当前正常/);
  assert.match(copy.ariaLabel, /点击切换为快速/);
  assert.match(copy.title, /闪电未点亮/);
});

test('issue speed toggle marks fast/on and clicks back to normal', () => {
  const copy = issueSpeedToggleCopy('priority');

  assert.equal(isFastIssueSpeed('priority'), true);
  assert.equal(copy.enabled, true);
  assert.equal(copy.currentLabel, '快速');
  assert.equal(copy.nextLabel, '正常');
  assert.equal(copy.nextServiceTier, '');
  assert.match(copy.ariaLabel, /当前快速/);
  assert.match(copy.ariaLabel, /点击切换为正常/);
  assert.match(copy.title, /闪电已点亮/);
});
