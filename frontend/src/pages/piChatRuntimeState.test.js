import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyPiConversationActivityEvent,
  isPiTextDeltaEvent,
  piConversationDetailState,
} from './piChatRuntimeState.js';

test('PiChat restores an active Turn snapshot after the page remounts', () => {
  const restored = piConversationDetailState({
    active_text: '已经生成的部分回答',
    active_turn_id: 'turn-live',
    runtime_status: 'running',
    transcript: [{ id: 'user-1', role: 'user', text: '继续处理' }],
  }, 'conv-live');

  assert.equal(restored.sending, true);
  assert.equal(restored.runningConversationId, 'conv-live');
  assert.deepEqual(restored.transcript.map((item) => [item.role, item.text]), [
    ['user', '继续处理'],
    ['assistant', '已经生成的部分回答'],
  ]);
});

test('PiChat projects global Turn events into sidebar status and activity order', () => {
  const conversations = [
    { id: 'recent-idle', last_activity_at: '2026-07-30T02:00:00Z', runtime_status: 'idle' },
    { id: 'live', last_activity_at: '2026-07-30T01:00:00Z', runtime_status: 'idle' },
  ];
  const running = applyPiConversationActivityEvent(conversations, {
    agent_event_type: 'agent_start',
    conversationId: 'live',
    created_at: '2026-07-30T03:00:00Z',
    turnId: 'turn-live',
  });
  const completed = applyPiConversationActivityEvent(running, {
    agent_event_type: 'agent_end',
    conversationId: 'live',
    created_at: '2026-07-30T04:00:00Z',
    status: 'completed',
    turnId: 'turn-live',
  });

  assert.deepEqual(running.map((item) => item.id), ['live', 'recent-idle']);
  assert.deepEqual(running[0], expectSubset({ active_turn_id: 'turn-live', runtime_status: 'running' }));
  assert.deepEqual(completed[0], expectSubset({ active_turn_id: '', runtime_status: 'idle' }));
});

test('PiChat only treats assistant text_delta events as resumable text', () => {
  assert.equal(isPiTextDeltaEvent({
    agent_event_type: 'message_update',
    payload: JSON.stringify({ assistant_event_type: 'text_delta' }),
    text: 'delta',
  }), true);
  assert.equal(isPiTextDeltaEvent({
    agent_event_type: 'message_update',
    payload: JSON.stringify({ assistant_event_type: 'thinking_delta' }),
    text: 'internal',
  }), false);
});

function expectSubset(expected) {
  return {
    ...expected,
    id: 'live',
    last_activity_at: expected.runtime_status === 'running'
      ? '2026-07-30T03:00:00Z'
      : '2026-07-30T04:00:00Z',
  };
}
