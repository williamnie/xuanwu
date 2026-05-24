import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createQueuedSessionMessage,
  enqueueQueuedSessionMessage,
  markQueuedSessionMessageFailed,
  markQueuedSessionMessageSending,
  nextPendingQueuedSessionMessage,
  normalizeQueuedSessionMessages,
  removeQueuedSessionMessage,
  retryQueuedSessionMessage,
} from './sessionMessageQueue.js';

test('queued session messages keep FIFO order per session', () => {
  const first = createQueuedSessionMessage({ id: 'a', sessionId: 'codex:t1', prompt: ' first ' });
  const second = createQueuedSessionMessage({ id: 'b', sessionId: 'codex:t1', prompt: 'second' });
  const other = createQueuedSessionMessage({ id: 'c', sessionId: 'codex:t2', prompt: 'other' });
  const queue = [first, other, second];

  assert.equal(nextPendingQueuedSessionMessage(queue, 'codex:t1')?.id, 'a');
  assert.equal(nextPendingQueuedSessionMessage(removeQueuedSessionMessage(queue, 'a'), 'codex:t1')?.id, 'b');
});

test('enqueue ignores duplicate ids without dropping repeated prompts', () => {
  const first = createQueuedSessionMessage({ id: 'a', sessionId: 'codex:t1', prompt: 'same' });
  const repeatedPrompt = createQueuedSessionMessage({ id: 'b', sessionId: 'codex:t1', prompt: 'same' });
  const queue = enqueueQueuedSessionMessage(enqueueQueuedSessionMessage([first], first), repeatedPrompt);

  assert.deepEqual(queue.map((item) => item.id), ['a', 'b']);
});

test('sending and failed messages are not auto-selected until retried', () => {
  const message = createQueuedSessionMessage({ id: 'a', sessionId: 'codex:t1', prompt: 'next' });
  const sending = markQueuedSessionMessageSending([message], 'a');
  assert.equal(nextPendingQueuedSessionMessage(sending, 'codex:t1'), null);

  const failed = markQueuedSessionMessageFailed(sending, 'a', 'network');
  assert.equal(nextPendingQueuedSessionMessage(failed, 'codex:t1'), null);
  assert.equal(failed[0].error, 'network');

  const retried = retryQueuedSessionMessage(failed, 'a');
  assert.equal(nextPendingQueuedSessionMessage(retried, 'codex:t1')?.id, 'a');
});

test('normalize pauses in-flight messages after refresh to avoid duplicate sends', () => {
  const queue = normalizeQueuedSessionMessages([
    { id: 'a', sessionId: 'codex:t1', prompt: 'next', status: 'sending' },
  ]);

  assert.equal(queue[0].status, 'failed');
  assert.match(queue[0].error, /避免重复发送/);
});
