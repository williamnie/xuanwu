import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalCalloutState, pendingApprovalCount } from './piCommandCenterState.js';

test('pending approval count reads command center overview safely', () => {
  assert.equal(pendingApprovalCount({ overview: { pending_approvals: 2 } }), 2);
  assert.equal(pendingApprovalCount({ overview: { pending_approvals: '1' } }), 1);
  assert.equal(pendingApprovalCount({}), 0);
});

test('approval callout presents pending approvals as diagnostics', () => {
  assert.deepEqual(approvalCalloutState(1), {
    detail: '日常确认请优先在 Feishu IM 或对应 issue detail 完成；这里保留高级排障入口，可复核原因、风险和范围。',
    status: '诊断提示',
    title: '1 项待确认动作可供审计',
    tone: 'needs-action',
  });
});

test('approval callout shows diagnostic clear state when no approvals are pending', () => {
  assert.deepEqual(approvalCalloutState(0), {
    detail: '新的 confirm/high 风险动作仍会保留在审计区；日常审批入口以 IM 和 issue detail 为主。',
    status: '诊断正常',
    title: '暂无待确认审计项',
    tone: 'clear',
  });
});
