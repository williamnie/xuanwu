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
  providerLabel,
  sessionIDFromCreateResult,
  sessionFromCreateResult,
  syncSessionRuntimeInList,
  upsertRunningSessionFromEvent,
  visibleApprovalsForSession,
} from './sessionPageRuntime.js';

test('provider session keys preserve the existing provider-prefixed identity', () => {
  assert.equal(providerSessionKey('codex', 'thread-1'), 'codex:thread-1');
  assert.equal(providerSessionKey('codex', 'codex:thread-1'), 'codex:thread-1');
  assert.equal(eventSessionKey({ provider: 'claude', threadId: 'session-2' }), 'claude:session-2');
  assert.equal(sessionIDFromCreateResult({ provider: 'codex', thread_id: 'thread-3' }), 'codex:thread-3');
  assert.equal(sessionIDFromCreateResult({ provider: 'pi-coding-agent', id: 'pi-session-1' }), 'pi-coding-agent:pi-session-1');
  assert.equal(providerLabel('pi-coding-agent'), 'Pi Coding Agent');
  const created = sessionFromCreateResult({
    provider: 'pi-coding-agent',
    provider_session_id: 'pi-session-1',
    provider_turn_id: 'turn-1',
  }, { id: 'demo', cwd: '/tmp/demo' });
  assert.deepEqual({
    ...created,
    createdAt: 0,
    updatedAt: 0,
  }, {
    id: 'pi-coding-agent:pi-session-1',
    provider: 'pi-coding-agent',
    provider_session_id: 'pi-session-1',
    thread_id: 'pi-session-1',
    project_id: 'demo',
    cwd: '/tmp/demo',
    preview: '',
    status: 'running',
    isRunning: true,
    createdAt: 0,
    updatedAt: 0,
  });
  assert.ok(Number.isInteger(created.createdAt));
  assert.ok(Number.isInteger(created.updatedAt));
});

test('Claude SDK live events retain provider-qualified identity', () => {
  const event = { type: 'claude.event', provider: 'claude', threadId: 'session-1', agent_event_type: 'turn_started' };
  assert.equal(isAgentEvent(event), true);
  assert.equal(eventSessionKey(event), 'claude:session-1');
  assert.equal(isSessionStartEvent(event), true);
  assert.equal(isSessionStartEvent({ ...event, agent_event_type: 'provider.session_started' }), true);
});

test('provider live events create a visible running session without replaying durable issue logs', () => {
  const event = {
    type: 'agent.event',
    agent_event_type: 'turn_started',
    provider: 'codex',
    threadId: 'thread-new',
    projectId: 'demo',
    issueId: 642,
    created_at: '2026-07-15T19:11:48Z',
  };

  assert.equal(isAgentEvent(event), true);
  assert.equal(isAgentEvent({ ...event, type: 'issue.log' }), false);
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
