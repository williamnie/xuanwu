import assert from 'node:assert/strict';
import test from 'node:test';
import { translate } from '../i18n/translations.js';
import { workHumanReviewCopy } from './workHumanReviewCopy.js';

test('product decisions and risk authorization do not present themselves as delivery acceptance', () => {
  const t = key => translate('zh-CN', key);
  assert.equal(workHumanReviewCopy('decision', t).accept, '确认并继续');
  assert.match(workHumanReviewCopy('decision', t).detail, /不表示修复已经完成/);
  assert.equal(workHumanReviewCopy('risk_acceptance', t).accept, '授权并继续');
  assert.match(workHumanReviewCopy('risk_acceptance', t).detail, /仅授权上方明确列出的操作/);
  assert.equal(workHumanReviewCopy('acceptance', t).accept, '接受交付');
  assert.match(workHumanReviewCopy('acceptance', t).detail, /按交付规则更新任务和关联平台状态/);
});

test('English review actions preserve the same three meanings', () => {
  const t = key => translate('en-US', key);
  assert.equal(workHumanReviewCopy('decision', t).accept, 'Confirm and continue');
  assert.equal(workHumanReviewCopy('risk_acceptance', t).accept, 'Authorize and continue');
  assert.equal(workHumanReviewCopy('acceptance', t).accept, 'Accept delivery');
});
