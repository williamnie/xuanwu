import assert from 'node:assert/strict';
import test from 'node:test';
import {
  eventSessionKey,
  isAgentEvent,
  isSessionRunning,
  isSessionStartEvent,
  mergeRefreshedSessions,
  normalizePendingApprovals,
  parseApprovalPayload,
  providerSessionKey,
  sessionIDFromCreateResult,
  syncSessionRuntimeInList,
  upsertRunningSessionFromEvent,
  visibleApprovalsForSession,
} from './sessionPageRuntime.js';

test('provider session keys preserve the existing provider-prefixed identity', () => {
  assert.equal(providerSessionKey('codex', 'thread-1'), 'codex:thread-1');
  assert.equal(providerSessionKey('codex', 'codex:thread-1'), 'codex:thread-1');
  assert.equal(eventSessionKey({ provider: 'claude', threadId: 'session-2' }), 'claude:session-2');
  assert.equal(sessionIDFromCreateResult({ provider: 'codex', thread_id: 'thread-3' }), 'codex:thread-3');
});

test('issue execution events create a visible running session before provider list refresh', () => {
  const event = {
    type: 'issue.log',
    agent_event_type: 'turn_started',
    provider: 'codex',
    threadId: 'thread-new',
    projectId: 'demo',
    issueId: 642,
    created_at: '2026-07-15T19:11:48Z',
  };

  assert.equal(isAgentEvent(event), true);
  assert.equal(isSessionStartEvent(event), true);
  assert.deepEqual(upsertRunningSessionFromEvent([], event, [{ id: 'demo', cwd: '/tmp/demo' }]), [{
    id: 'codex:thread-new',
    provider: 'codex',
    provider_session_id: 'thread-new',
    thread_id: 'thread-new',
    project_id: 'demo',
    cwd: '/tmp/demo',
    name: 'Issue #642',
    preview: 'Issue #642 正在执行',
    status: 'running',
    isRunning: true,
    createdAt: 1784142708,
    updatedAt: 1784142708,
  }]);
});

test('runtime status and list refresh keep loaded sessions without duplicating identities', () => {
  assert.equal(isSessionRunning({ status: JSON.stringify({ type: 'running' }) }), true);
  assert.equal(isSessionRunning({ pending_approvals: [{ id: 'approval-1' }] }), true);
  assert.equal(isSessionRunning({ status: 'completed' }), false);

  const current = [{ id: 'a', name: 'old' }, { id: 'b', name: 'loaded' }];
  assert.deepEqual(mergeRefreshedSessions(current, [{ id: 'a', name: 'fresh' }]), [
    { id: 'a', name: 'fresh' },
    { id: 'b', name: 'loaded' },
  ]);
  assert.deepEqual(syncSessionRuntimeInList(current, {
    id: 'a', name: 'detail', status: 'running', pending_approvals: [],
  }, true), [
    {
      id: 'a',
      name: 'detail',
      preview: undefined,
      status: 'running',
      origin: undefined,
      updatedAt: undefined,
      pending_approvals: [],
      isRunning: true,
    },
    { id: 'b', name: 'loaded' },
  ]);
});

test('approval parsing and selection preserve create-session fallback behavior', () => {
  assert.deepEqual(parseApprovalPayload({ method: 'approval/requested', params: { callId: 'call-1' } }), {
    id: 'call-1', method: 'approval/requested', params: { callId: 'call-1' },
  });
  assert.deepEqual(normalizePendingApprovals([{ params: { callId: 'ignored-without-id' } }, { id: 'approval-2' }]), [
    { id: 'approval-2', method: 'approval/requested', params: {} },
  ]);

  const queue = [
    { sessionId: '', request: { id: 'create-approval' } },
    { sessionId: 'codex:thread-1', request: { id: 'thread-approval' } },
  ];
  assert.deepEqual(visibleApprovalsForSession(queue, ''), [queue[0]]);
  assert.deepEqual(visibleApprovalsForSession(queue, 'codex:thread-1'), [queue[1]]);
  assert.deepEqual(visibleApprovalsForSession([queue[1]], ''), [queue[1]]);
});
