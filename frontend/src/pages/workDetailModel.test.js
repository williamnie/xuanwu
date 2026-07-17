import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildWorkActionPayload,
  filterTimelineItems,
  mergeTimelinePages,
  workAttentionSignals,
  workAvailableActions,
} from './workDetailModel.js';

test('Work actions follow the shared state transition surface', () => {
  assert.deepEqual(workAvailableActions('triage'), {
    cancel: true,
    edit: true,
    retry: false,
    review: false,
    start: true,
  });
  assert.equal(workAvailableActions('in_progress').edit, false);
  assert.equal(workAvailableActions('pending_verification').review, true);
  assert.equal(workAvailableActions('failed').retry, true);
  assert.deepEqual(workAvailableActions('done'), {
    cancel: false,
    edit: true,
    retry: false,
    review: false,
    start: false,
  });
});

test('Work action payload is deterministic, revision guarded, and auditable', () => {
  assert.deepEqual(buildWorkActionPayload({ id: 'xw:work:issues:700', revision: 12 }, 'enqueue', {
    nonce: 'start-1',
    occurredAt: '2026-07-17T00:00:00.000Z',
  }), {
    audit: {
      actor: { id: 'work-detail-user', kind: 'user' },
      correlation_id: 'work-detail:xw:work:issues:700',
      event_id: 'work-detail:enqueue:start-1',
      occurred_at: '2026-07-17T00:00:00.000Z',
      reason: 'User requested Work enqueue from Work Detail',
    },
    expected_revision: 12,
  });
});

test('timeline pagination stays deduplicated and filterable', () => {
  const first = [timeline('two', '2026-07-17T00:02:00Z', 'run'), timeline('one', '2026-07-17T00:01:00Z', 'work_event')];
  const merged = mergeTimelinePages(first, [timeline('one', '2026-07-17T00:01:00Z', 'work_event'), timeline('zero', '2026-07-17T00:00:00Z', 'run')]);
  assert.deepEqual(merged.map(item => item.id), ['two', 'one', 'zero']);
  assert.deepEqual(filterTimelineItems(merged, 'run').map(item => item.id), ['two', 'zero']);
});

test('Attention combines Work, relation, unresolved approval and Guardian signals', () => {
  const signals = workAttentionSignals(
    { status: 'pending_verification' },
    [{ kind: 'execution', lifecycle: 'failed', relation_id: 'relation-1' }],
    [
      { id: 'approval-open', kind: 'approval', occurred_at: '2026-07-17T00:00:00Z', source: { external_id: 'approval-1' }, status: 'pending', summary: 'Needs approval' },
      { id: 'approval-resolved', kind: 'approval', occurred_at: '2026-07-17T00:01:00Z', source: { external_id: 'approval-2' }, status: 'resolved' },
    ],
    [{ alert_type: 'stalled_work', id: 'guardian-1', message: 'No progress', severity: 'watch', status: 'open' }],
  );
  assert.deepEqual(signals.map(item => item.kind), ['work', 'relationship', 'approval', 'guardian']);
  assert.equal(signals.some(item => item.id === 'approval:approval-2'), false);
});

function timeline(id, occurredAt, kind) {
  return { id, kind, occurred_at: occurredAt };
}
