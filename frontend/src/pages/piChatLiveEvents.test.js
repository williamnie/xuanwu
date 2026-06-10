import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendPiAssistantDelta,
  endsPiAssistantMessage,
  isPiRunEndEvent,
  isPiRunStartEvent,
  isSelectedPiConversationEvent,
  startsPiAssistantMessage,
  visiblePiAssistantDelta,
} from './piChatLiveEvents.js';

const baseEvent = {
  type: 'pi.conversation.event',
  conversationId: 'conv-1',
  agent_event_type: 'message_update',
  text: 'hello',
  payload: JSON.stringify({ type: 'message_update', role: 'assistant', assistant_event_type: 'text_delta' }),
};

test('Runner live events only accept the selected PI conversation', () => {
  assert.equal(isSelectedPiConversationEvent(baseEvent, 'conv-1'), true);
  assert.equal(isSelectedPiConversationEvent(baseEvent, 'conv-2'), false);
  assert.equal(isSelectedPiConversationEvent({ ...baseEvent, type: 'issue.log' }, 'conv-1'), false);
});

test('Runner live events expose only assistant text deltas', () => {
  assert.equal(visiblePiAssistantDelta(baseEvent), 'hello');
  assert.equal(visiblePiAssistantDelta({ ...baseEvent, payload: JSON.stringify({ role: 'user', assistant_event_type: 'text_delta' }) }), '');
  assert.equal(visiblePiAssistantDelta({ ...baseEvent, payload: JSON.stringify({ role: 'assistant', assistant_event_type: 'thinking_delta' }) }), '');
});

test('Runner live events append deltas into one live assistant bubble', () => {
  const first = appendPiAssistantDelta([], 'live-1', 'hel', baseEvent);
  const second = appendPiAssistantDelta(first, 'live-1', 'lo', baseEvent);

  assert.deepEqual(second.map((item) => ({ id: item.id, role: item.role, text: item.text })), [
    { id: 'live-1', role: 'assistant', text: 'hello' },
  ]);
});

test('Runner live events classify PI run and assistant boundaries', () => {
  assert.equal(isPiRunStartEvent({ agent_event_type: 'agent_start' }), true);
  assert.equal(isPiRunEndEvent({ agent_event_type: 'agent_end' }), true);
  assert.equal(startsPiAssistantMessage({ agent_event_type: 'message_start', payload: JSON.stringify({ role: 'assistant' }) }), true);
  assert.equal(endsPiAssistantMessage({ agent_event_type: 'message_end', payload: JSON.stringify({ role: 'assistant' }) }), true);
});
