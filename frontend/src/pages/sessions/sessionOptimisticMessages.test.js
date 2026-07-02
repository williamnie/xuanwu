import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countPersistedUserMessages,
  createOptimisticSessionUserMessage,
  reconcileOptimisticSessionUserMessages,
} from './sessionOptimisticMessages.js';

function sessionWithUserTexts(id, texts) {
  return {
    id,
    turns: texts.map((text, index) => ({
      id: `turn-${index}`,
      items: [{ type: 'userMessage', content: [{ type: 'input_text', text }] }],
    })),
  };
}

test('optimistic user message records the current persisted count', () => {
  const session = sessionWithUserTexts('codex:t1', ['repeat']);
  const message = createOptimisticSessionUserMessage({
    id: 'local-1',
    sessionId: 'codex:t1',
    prompt: ' repeat ',
    session,
    createdAt: '2026-07-02T00:00:00.000Z',
  });

  assert.equal(message.prompt, 'repeat');
  assert.equal(message.persistedCountBefore, 1);
  assert.equal(message.createdAt, '2026-07-02T00:00:00.000Z');
});

test('reconcile keeps optimistic repeat until a new persisted copy appears', () => {
  const message = createOptimisticSessionUserMessage({
    id: 'local-1',
    sessionId: 'codex:t1',
    prompt: 'repeat',
    session: sessionWithUserTexts('codex:t1', ['repeat']),
  });

  assert.equal(
    reconcileOptimisticSessionUserMessages([message], sessionWithUserTexts('codex:t1', ['repeat'])).length,
    1,
  );
  assert.equal(
    reconcileOptimisticSessionUserMessages([message], sessionWithUserTexts('codex:t1', ['repeat', 'repeat'])).length,
    0,
  );
});

test('reconcile only removes messages for the hydrated session', () => {
  const messages = [
    createOptimisticSessionUserMessage({ id: 'a', sessionId: 'codex:t1', prompt: 'hello' }),
    createOptimisticSessionUserMessage({ id: 'b', sessionId: 'codex:t2', prompt: 'hello' }),
  ];
  const reconciled = reconcileOptimisticSessionUserMessages(messages, sessionWithUserTexts('codex:t1', ['hello']));

  assert.deepEqual(reconciled.map((message) => message.id), ['b']);
});

test('blank optimistic messages are ignored', () => {
  assert.equal(createOptimisticSessionUserMessage({ id: 'a', sessionId: 'codex:t1', prompt: '   ' }), null);
});

test('persisted user count uses displayed user text', () => {
  const session = sessionWithUserTexts('codex:t1', [
    ['Files mentioned by the user:', '', 'My request for Codex:', '', 'hello'].join('\n'),
  ]);

  assert.equal(countPersistedUserMessages(session, 'hello'), 1);
});
