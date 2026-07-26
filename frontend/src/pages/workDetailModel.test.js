import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildWorkActionPayload,
  filterTimelineItems,
  mergeTimelinePages,
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

function timeline(id, occurredAt, kind) {
  return { id, kind, occurred_at: occurredAt };
}
