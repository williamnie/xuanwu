import assert from 'node:assert/strict';
import test from 'node:test';

import {
  approvalsForSession,
  enqueueApprovalNotice,
  hasApprovalForSession,
  removeApprovalRequest,
  removeApprovalsForSession,
  syncApprovalsForSession,
} from './approvalQueue.js';

test('approval queue keeps requests FIFO per session and deduplicates ids', () => {
  const queue = [
    { sessionId: 'codex:a', request: { id: 'a-1' } },
    { sessionId: 'codex:b', request: { id: 'b-1' } },
  ];

  const next = enqueueApprovalNotice(queue, { sessionId: 'codex:a', request: { id: 'a-2' } });
  const deduped = enqueueApprovalNotice(next, { sessionId: 'codex:a', request: { id: 'a-1' } });

  assert.equal(deduped.length, 3);
  assert.deepEqual(approvalsForSession(deduped, 'codex:a').map((item) => item.request.id), ['a-1', 'a-2']);
});

test('approval queue removes one resolved request or a stopped session', () => {
  const queue = [
    { sessionId: 'codex:a', request: { id: 'a-1' } },
    { sessionId: 'codex:a', request: { id: 'a-2' } },
    { sessionId: 'codex:b', request: { id: 'b-1' } },
  ];

  const afterResolve = removeApprovalRequest(queue, { id: 'a-1' });
  assert.deepEqual(approvalsForSession(afterResolve, 'codex:a').map((item) => item.request.id), ['a-2']);
  assert.equal(hasApprovalForSession(afterResolve, 'codex:b'), true);

  const afterStop = removeApprovalsForSession(afterResolve, 'codex:a');
  assert.equal(hasApprovalForSession(afterStop, 'codex:a'), false);
  assert.deepEqual(afterStop.map((item) => item.request.id), ['b-1']);
});

test('approval queue sync replaces only the selected session snapshot', () => {
  const queue = [
    { sessionId: 'codex:a', request: { id: 'stale-a' } },
    { sessionId: 'codex:b', request: { id: 'keep-b' } },
  ];

  const synced = syncApprovalsForSession(queue, 'codex:a', [{ id: 'fresh-a' }, { id: 'fresh-a' }]);

  assert.deepEqual(approvalsForSession(synced, 'codex:a').map((item) => item.request.id), ['fresh-a']);
  assert.deepEqual(approvalsForSession(synced, 'codex:b').map((item) => item.request.id), ['keep-b']);
});
