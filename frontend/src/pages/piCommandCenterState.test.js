import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalCalloutState, pendingApprovalCount } from './piCommandCenterState.js';

test('pending approval count reads command center overview safely', () => {
  assert.equal(pendingApprovalCount({ overview: { pending_approvals: 2 } }), 2);
  assert.equal(pendingApprovalCount({ overview: { pending_approvals: '1' } }), 1);
  assert.equal(pendingApprovalCount({}), 0);
});

test('approval callout highlights pending approvals', () => {
  assert.deepEqual(approvalCalloutState(1), {
    detail: '先确认下方动作的原因、风险和范围，再决定批准、要求修改、暂缓或拒绝。',
    status: '需要你处理',
    title: '1 项待审批动作优先处理',
    tone: 'needs-action',
  });
});

test('approval callout shows clear state when no approvals are pending', () => {
  assert.deepEqual(approvalCalloutState(0), {
    detail: '新的 confirm/high 风险动作会出现在这里；需要时再查看下方证据模块。',
    status: '当前无阻塞',
    title: '暂无待审批动作',
    tone: 'clear',
  });
});
