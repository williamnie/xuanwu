import assert from 'node:assert/strict';
import test from 'node:test';

import { commandHistoryItems } from './sessionCommandHistory.js';

test('formats persisted command history into replay cards with issue links', () => {
  const items = commandHistoryItems([
    { id: 1, command_name: 'issue', created_issue_id: 101, result_summary: 'created triage issue #101' },
    { id: 2, command_name: 'run', enqueued_issue_id: 101, result_summary: 'enqueued issue #101' },
    { id: 3, command_name: 'status', target_issue_id: 101, result_summary: 'issue #101 is todo' },
  ]);

  assert.deepEqual(items.map((item) => item.title), [
    '/issue created #101',
    '/run enqueued #101',
    '/status issue #101 is todo',
  ]);
  assert.deepEqual(items.map((item) => item.issueId), [101, 101, 101]);
});

test('keeps failed command replay visible without leaking into fake issue link', () => {
  const [item] = commandHistoryItems([
    { id: 4, command_name: 'run', error: '/run 需要确认后才能 enqueue issue' },
  ]);

  assert.equal(item.title, '/run failed');
  assert.equal(item.error, '/run 需要确认后才能 enqueue issue');
  assert.equal(item.issueId, 0);
});
