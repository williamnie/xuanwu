import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { attentionActionPayload, attentionView } from './attentionModel.js';

const ITEM = { id: 'xw:attention:pi_guardian_alerts:alert-1', priority: 'p0', revision: 3, status: 'open', type: 'connection_issue' };

test('Attention labels every action-required type deterministically', () => {
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
      reason: 'Dashboard user requested Attention acknowledge',
    },
    expected_revision: 3,
  });
  assert.equal(attentionActionPayload(ITEM, 'snooze', input).snoozed_until, '2026-07-17T09:00:00.000Z');
});

test('Dashboard separates E1 inbox commands from automatic operations without duplicate user counts', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  const page = read('./AttentionSection.jsx');
  const inbox = read('./TaskRequestsSection.jsx');
  const commands = read('./useAttentionActions.js');
  const refresh = read('./useInbox.js');
  const dashboard = read('../Dashboard.jsx');
  const api = read('../../api/commandCenter.js');
  assert.match(page, /sections: \['attention'\]/);
  const operations = page.slice(0, page.indexOf('export function AttentionCard'));
  assert.doesNotMatch(operations, /groupAttentionByPriority|section\.items|counts\.total|typeFilter|controlAttention/);
  assert.match(page, /PiOperationsSummary/);
  assert.match(page, /玄武自动运维/);
  assert.match(page, /最近已恢复/);
  assert.doesNotMatch(page, /active_user_action_required/);
  assert.match(inbox, /<AttentionCard/);
  assert.match(inbox, /<ApprovalDetail/);
  assert.match(inbox, /<ModalOverlay/);
  assert.match(inbox, /inboxIsEmpty\(state\)/);
  assert.match(inbox, /state\.failedSources/);
  assert.match(inbox, /onClick=\{loadMore\}/);
  assert.doesNotMatch(inbox, /getWorks|getWork\(|SHOWN_PER_STATUS/);
  assert.match(commands, /controlAttention/);
  assert.match(commands, /await refresh\(\)/);
  assert.match(commands, /getAttention/);
  assert.match(commands, /decision_ref: target\.ref/);
  assert.match(commands, /attentionActionPayload/);
  assert.match(page, /inbox\.nextAction/);
  assert.match(page, /inbox\.acknowledge/);
  assert.match(page, /inbox\.sourceFacts/);
  assert.match(page, /href=\{item\.links\?\.self\}/);
  assert.match(page, /approve_always/);
  assert.match(page, /Gate layer/);
  assert.match(page, /Reason code/);
  assert.match(page, /formatGateScope/);
  assert.match(page, /编程工具 Policy · Agent 工具权限/);
  assert.match(page, /Completion Gate · 完成验收/);
  assert.match(page, /disabled=\{Boolean\(submitting\) \|\| !canApprove\}/);
  assert.match(page, /notification\?\.delivery === 'sent'/);
  assert.match(refresh, /subscribeToEvents/);
  assert.match(refresh, /setInterval\(controller\.refreshAutomatically, 30_000\)/);
  assert.match(inbox, /onSubmitted: refreshAutomatically/);
  assert.match(inbox, /useAttentionActions\(refreshAutomatically\)/);
  assert.match(inbox, /await refreshAutomatically\(\)/);
  assert.match(inbox, /onClick=\{refresh\}/);
  assert.match(api, /\/api\/command-center\/inbox/);
  assert.match(api, /\/api\/command-center\/attention\/\$\{encodeURIComponent\(id\)\}\/actions/);
  assert.doesNotMatch(api, /\/api\/pi\/approval-requests/);
  assert.match(dashboard, /<AttentionSection \/>/);
  assert.match(dashboard, /inboxSummary\?\.total/);
  assert.doesNotMatch(dashboard, /counts\.needs_user|counts\.failed/);
});
