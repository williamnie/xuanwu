import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deliveryEvidenceRows,
  deliveryHistoryLabel,
  deliveryRefRows,
  workDeliveryView,
} from './workDeliveryModel.js';

const HANDOFF_ID = 'xw:handoff:derived:issue-809';
const WORK_ID = 'xw:work:issues:809';

test('local Handoff is presented as an Issue delivery receipt rather than a commit', () => {
  const detail = fixtureDetail();
  const view = workDeliveryView({
    detail,
    evidence: [
      { id: 'xw:evidence:git:809', kind: 'git', status: 'passed' },
      { id: 'xw:evidence:test:809', kind: 'test', status: 'passed' },
    ],
    work: { status: 'done' },
  });

  assert.equal(view.modeLabel, '本地改动快照');
  assert.match(view.deliverySummary, /没有创建 commit、push 或部署/);
  assert.equal(view.evidencePassed, 2);
  assert.equal(view.nextAction, '无需额外操作');
  assert.equal(view.statusLabel, '交付凭证已就绪');
});

test('high-risk attribution remains visible as a delivery action', () => {
  const risky = fixtureDetail({
    handoff: {
      ...fixtureDetail().handoff,
      risks: [{ id: 'handoff_attribution_uncertainty', severity: 'high' }],
    },
  });
  assert.equal(workDeliveryView({ detail: risky }).nextAction, '检查高风险归因问题');
});

test('Evidence and delivery refs retain exact audit identifiers under readable labels', () => {
  const detail = fixtureDetail();
  const rows = deliveryEvidenceRows(detail, [{
    decisive_summary: '19 pass; 0 fail',
    id: 'xw:evidence:test:809',
    kind: 'test',
    observed_at: '2026-07-26T04:52:27.000Z',
    status: 'passed',
  }]);
  assert.deepEqual(rows.map(row => row.loaded), [false, true]);
  assert.equal(rows[1].summary, '19 pass; 0 fail');
  assert.deepEqual(deliveryRefRows(detail.handoff), [{ label: '工作区快照', value: 'git-snapshot:809' }]);
  assert.deepEqual(deliveryHistoryLabel({
    delivery_status: { overall: 'ready' },
    issue: { id: 809 },
    revision: 1,
    work_id: WORK_ID,
  }), {
    issueLabel: 'Issue #809',
    revisionLabel: '版本 2',
    statusLabel: '交付凭证已就绪',
  });
});

test('legacy done Work without Handoff is explicit instead of inferred as delivered', () => {
  const view = workDeliveryView({ work: { status: 'done' } });
  assert.equal(view.statusLabel, '无 Handoff');
  assert.match(view.deliverySummary, /历史完成记录/);
});

function fixtureDetail(overrides = {}) {
  return {
    delivery_status: { overall: 'ready' },
    handoff: {
      changed_files: ['backend-ts/src/http/workApi.test.ts'],
      delivery: { mode: 'local_changes', working_tree_ref: 'git-snapshot:809' },
      delivery_actions: [],
      evidence_ids: ['xw:evidence:git:809', 'xw:evidence:test:809'],
      id: HANDOFF_ID,
      risks: [],
      status: 'ready',
      work_id: WORK_ID,
    },
    ...overrides,
  };
}

test('planned push is never presented as successful and missing evidence needs action', () => {
  const detail = fixtureDetail();
  detail.handoff.delivery = { mode: 'push', remote_ref: 'refs/heads/main' };
  detail.handoff.delivery_actions = [{ action: 'push', required: true, outcome: 'not_executed', audit_event_ref: 'push:1' }];
  const view = workDeliveryView({ detail });
  assert.equal(view.milestones.find(item => item.key === 'push').status, 'pending');
  assert.doesNotMatch(view.deliverySummary, /已推送/);
  assert.equal(view.nextAction, '读取或补齐验证证据');
  detail.delivery_status.actions = [{ action: 'push', source_ref: 'push:1', current_status: 'failed' }];
  assert.equal(workDeliveryView({ detail }).milestones.find(item => item.key === 'push').status, 'failed');
});

test('a previous Work detail cannot appear as the selected Work delivery', () => {
  assert.equal(workDeliveryView({ detail: fixtureDetail(), work: { id: 'xw:work:issues:999' } }).status, 'missing');
});

test('failed checks and pending review remain actionable', () => {
  const detail = fixtureDetail();
  const evidence = detail.handoff.evidence_ids.map(id => ({ id, status: 'passed', kind: 'test' }));
  evidence[0].status = 'failed';
  assert.equal(workDeliveryView({ detail, evidence }).nextAction, '处理未通过的验证');
  evidence[0].status = 'passed';
  detail.handoff.review = { state: 'pending' };
  assert.equal(workDeliveryView({ detail, evidence }).nextAction, '完成交付评审');
});
