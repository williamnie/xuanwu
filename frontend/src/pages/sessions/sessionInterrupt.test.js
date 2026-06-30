import assert from 'node:assert/strict';
import test from 'node:test';

import {
  interruptCompletionNotice,
  interruptFailureNotice,
  interruptRequestNotice,
  isInterruptPendingForSession,
  isSessionStopEvent,
} from './sessionInterrupt.js';

test('interrupt request notice keeps linked issue pending until terminal event', () => {
  const notice = interruptRequestNotice('codex:thread-1', {
    interrupted: true,
    issue: { id: 76, status: 'in_progress' },
  });

  assert.equal(notice.status, 'pending');
  assert.equal(isInterruptPendingForSession(notice, 'codex:thread-1'), true);
  assert.match(notice.text, /Issue #76/);
  assert.match(notice.text, /状态保持 in_progress/);
  assert.doesNotMatch(notice.text, /已进入|回收/);
});

test('interrupt completion notice distinguishes completed cancelled and error events', () => {
  const completed = interruptCompletionNotice('codex:thread-1', {
    agent_event_type: 'agent.turn.completed',
    status: 'completed',
  });
  assert.equal(completed.status, 'done');
  assert.match(completed.text, /已结束/);

  const cancelled = interruptCompletionNotice('codex:thread-1', {
    method: 'turn/completed',
    status: 'cancelled',
  });
  assert.equal(cancelled.status, 'done');
  assert.match(cancelled.text, /已取消/);

  const errored = interruptCompletionNotice('codex:thread-1', {
    agent_event_type: 'agent.error',
    error: 'interrupted by user',
  });
  assert.equal(errored.status, 'error');
  assert.match(errored.text, /interrupted by user/);
});

test('interrupt stop event matcher accepts cancelled terminal shapes', () => {
  assert.equal(isSessionStopEvent({ method: 'turn/completed' }), true);
  assert.equal(isSessionStopEvent({ agent_event_type: 'agent.error' }), true);
  assert.equal(isSessionStopEvent({ agent_event_type: 'agent.turn.cancelled' }), true);
  assert.equal(isSessionStopEvent({ method: 'turn/canceled' }), true);
  assert.equal(isSessionStopEvent({ method: 'turn/started' }), false);
});

test('interrupt failure notice is not pending', () => {
  const notice = interruptFailureNotice('codex:thread-1', new Error('network down'));
  assert.equal(notice.status, 'error');
  assert.equal(isInterruptPendingForSession(notice, 'codex:thread-1'), false);
  assert.match(notice.text, /network down/);
});
