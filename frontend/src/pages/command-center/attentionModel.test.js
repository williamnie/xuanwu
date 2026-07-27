import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { attentionActionPayload, attentionView, groupAttentionByPriority } from './attentionModel.js';

const ITEM = { id: 'xw:attention:pi_guardian_alerts:alert-1', priority: 'p0', revision: 3, status: 'open', type: 'connection_issue' };

test('Attention groups priority and labels every action-required type deterministically', () => {
  const groups = groupAttentionByPriority([ITEM, { ...ITEM, id: 'approval', priority: 'p2', type: 'approval_required' }]);
  assert.deepEqual(groups.p0.map(item => item.id), [ITEM.id]);
  assert.deepEqual(groups.p2.map(item => item.id), ['approval']);
  assert.equal(attentionView({ ...ITEM, type: 'approval_required' }).typeLabel, '等待审批');
  assert.equal(attentionView({ ...ITEM, type: 'blocker' }).typeLabel, '阻塞');
  assert.equal(attentionView({ ...ITEM, type: 'failure' }).typeLabel, '失败');
  assert.equal(attentionView({ ...ITEM, type: 'input_required' }).typeLabel, '等待输入');
  assert.equal(attentionView({ ...ITEM, type: 'verification_required' }).typeLabel, '待验收');
});

test('Attention commands carry a human allow gate, revision, audit identifiers, and snooze expiry', () => {
  const input = { nonce: 'fixture', occurredAt: '2026-07-17T08:00:00.000Z' };
  assert.deepEqual(attentionActionPayload(ITEM, 'acknowledge', input), {
    audit: {
      actor: { id: 'frontend:user', kind: 'user' },
      correlation_id: ITEM.id.replace(/^/, 'command-center:'),
      event_id: 'command-center:attention:acknowledge:fixture',
      gate: { authority: 'human_approval', decision: 'allow', policy_ref: 'command-center:human-attention-action' },
      occurred_at: '2026-07-17T08:00:00.000Z',
      reason: 'Command Center user requested Attention acknowledge',
    },
    expected_revision: 3,
  });
  assert.equal(attentionActionPayload(ITEM, 'snooze', input).snoozed_until, '2026-07-17T09:00:00.000Z');
});

test('Command Center Attention has grouped cards, canonical source links, empty state, and post-action refresh', () => {
  const page = readFileSync(new URL('./AttentionSection.jsx', import.meta.url), 'utf8');
  const dashboard = readFileSync(new URL('../Dashboard.jsx', import.meta.url), 'utf8');
  const api = readFileSync(new URL('../../api/commandCenter.js', import.meta.url), 'utf8');
  assert.match(page, /sections: \['attention'\]/);
  assert.match(page, /groupAttentionByPriority/);
  assert.match(page, /controlAttention/);
  assert.match(page, /await load\(\{ silent: true \}\)/);
  assert.match(page, /当前没有需要你介入的事项/);
  assert.match(page, /这里只放未送达或必须兜底处理的事项/);
  assert.match(page, /PI 自动运维/);
  assert.match(page, /需要你做什么/);
  assert.match(page, /我知道了，不再显示/);
  assert.match(page, /最近已恢复/);
  assert.doesNotMatch(page, /navigateTo\?\.\('attention-inbox'\)/);
  assert.match(page, /查看来源事实/);
  assert.match(page, /href=\{item\.links\?\.self\}/);
  assert.match(page, /ApprovalDetail/);
  assert.match(page, /resolveApproval/);
  assert.match(page, /getAttention/);
  assert.match(page, /decision_ref/);
  assert.match(page, /approve_always/);
  assert.match(page, /已推送飞书，页面仅保留/);
  assert.match(page, /isPushedApproval/);
  assert.match(page, /subscribeToEvents/);
  assert.match(page, /Attention 类型筛选/);
  assert.match(api, /\/api\/command-center\/attention\/\$\{encodeURIComponent\(id\)\}\/actions/);
  assert.doesNotMatch(api, /\/api\/pi\/approval-requests/);
  assert.match(dashboard, /<AttentionSection \/>/);
});
