import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendPiTurnDelta,
  createPiChatTurnManager,
  hydrateCompletedPiTurn,
  replacePiTurnText,
} from './piChatTurn.js';

test('PiChat appends ordered deltas exactly once into the active Turn bubble', () => {
  const first = appendPiTurnDelta([], 'turn-1', 'hel', 'conv-1');
  const second = appendPiTurnDelta(first, 'turn-1', 'lo', 'conv-1');

  assert.deepEqual(second, [{
    id: 'pi-turn-turn-1',
    role: 'assistant',
    text: 'hello',
    meta: {
      conversation_id: 'conv-1',
      live: true,
      turn_id: 'turn-1',
    },
  }]);
});

test('PiChat restores the latest active Turn snapshot after remounting', () => {
  const restored = replacePiTurnText(
    [{ id: 'user-1', role: 'user', text: 'hello' }],
    'turn-live',
    'partial reply',
    'conv-1',
  );
  const updated = replacePiTurnText(restored, 'turn-live', 'new snapshot', 'conv-1');

  assert.equal(updated.length, 2);
  assert.deepEqual(updated[1], {
    id: 'pi-turn-turn-live',
    role: 'assistant',
    text: 'new snapshot',
    meta: {
      conversation_id: 'conv-1',
      live: true,
      turn_id: 'turn-live',
    },
  });
});

test('switching conversations aborts and invalidates the previous stream', () => {
  const manager = createPiChatTurnManager();
  const first = manager.begin('conv-1');
  const second = manager.begin('conv-2');

  assert.equal(first.controller.signal.aborted, true);
  assert.equal(first.cancelReason, 'replaced');
  assert.equal(manager.isCurrent(first), false);
  assert.equal(manager.isCurrent(second), true);

  const switched = manager.cancel('conversation_switch');
  assert.equal(switched, second);
  assert.equal(second.controller.signal.aborted, true);
  assert.equal(second.cancelReason, 'conversation_switch');
  assert.equal(manager.current(), null);
});

test('stop aborts the current stream and finish cannot clear a replacement Turn', () => {
  const manager = createPiChatTurnManager();
  const stopped = manager.begin('conv-1');
  manager.cancel('stop');
  const replacement = manager.begin('conv-2');

  assert.equal(stopped.controller.signal.aborted, true);
  assert.equal(stopped.cancelReason, 'stop');
  assert.equal(manager.finish(stopped), false);
  assert.equal(manager.isCurrent(replacement), true);
});

test('completed Turn hydrates the persisted conversation and ignores a switched conversation', async () => {
  const hydrated = [];
  const applied = await hydrateCompletedPiTurn({
    conversationId: 'conv-1',
    getConversation: async (id) => ({ id, transcript: [{ role: 'assistant', text: 'persisted' }] }),
    isCurrent: () => true,
    onHydrated: (detail) => hydrated.push(detail),
  });
  const ignored = await hydrateCompletedPiTurn({
    conversationId: 'conv-old',
    getConversation: async (id) => ({ id, transcript: [{ role: 'assistant', text: 'stale' }] }),
    isCurrent: () => false,
    onHydrated: (detail) => hydrated.push(detail),
  });

  assert.equal(applied, true);
  assert.equal(ignored, false);
  assert.deepEqual(hydrated, [{
    id: 'conv-1',
    transcript: [{ role: 'assistant', text: 'persisted' }],
  }]);
});
