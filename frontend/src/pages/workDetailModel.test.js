import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildWorkActionPayload,
  defaultWorkDetailTab,
  filterTimelineItems,
  mergeTimelinePages,
  workAvailableActions,
  workBlockReason,
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
  assert.equal(workAvailableActions('needs_user').review, false);
  assert.equal(workAvailableActions('needs_user', {
    owner: 'human',
    request: { status: 'open' },
  }).review, true);
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
  assert.deepEqual(filterTimelineItems(merged).map(item => item.id), ['one']);
  assert.deepEqual(filterTimelineItems(merged, 'run'), []);
  assert.deepEqual(filterTimelineItems([...merged, timeline('event', '2026-07-17T00:04:00Z', 'issue_event')]).map(item => item.id), ['one']);
  assert.deepEqual(filterTimelineItems(merged, 'work_event').map(item => item.id), ['one']);
});

function timeline(id, occurredAt, kind) {
  return { id, kind, occurred_at: occurredAt };
}

test('Work block reason only reports facts the project API provides', () => {
  const queued = { status: 'todo' };
  assert.equal(workBlockReason(queued, null), '');
  assert.equal(workBlockReason(queued, { auto_run: 1 }), '');
  assert.match(workBlockReason(queued, { auto_run: 0 }), /未开启自动执行/);
  assert.match(workBlockReason(queued, { auto_run: 1, hold: { reason: 'usage_limit' } }), /项目已暂停（用量\/限额）/);
  assert.equal(workBlockReason({ status: 'triage' }, { auto_run: 0 }), '');
  assert.equal(workBlockReason({ status: 'in_progress' }, { auto_run: 1, hold: { reason: 'x' } }), '');
});

test('Work Detail opens the tab that matches the deep link, then the task state', () => {
  assert.equal(defaultWorkDetailTab('done', { selectedHandoffId: 'handoff:1', selectedRunId: 'run:1' }), 'result');
  assert.equal(defaultWorkDetailTab('done', { selectedRunId: 'run:1' }), 'runs');
  assert.equal(defaultWorkDetailTab('triage'), 'description');
  assert.equal(defaultWorkDetailTab('todo'), 'description');
  assert.equal(defaultWorkDetailTab('in_progress'), 'runs');
  for (const status of ['done', 'failed', 'needs_user', 'cancelled']) assert.equal(defaultWorkDetailTab(status), 'result');
});
