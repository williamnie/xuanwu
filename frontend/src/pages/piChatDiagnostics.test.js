import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatPiConversationDebugInfo,
  formatPiErrorDebugInfo,
  formatPiMessageDebugInfo,
} from './piChatDiagnostics.js';

test('formats PI conversation debug info with stable chat and runtime ids', () => {
  const text = formatPiConversationDebugInfo({
    id: 'conv-123',
    pi_session_id: 'pi-session-456',
    title: 'Need a fix',
    status: 'active',
    project_id: 'runner',
    pi_agent_id: 'runner-default',
    created_at: '2026-07-08T01:00:00.000Z',
    updated_at: '2026-07-08T02:00:00.000Z',
  });

  assert.match(text, /type: pi_conversation/);
  assert.match(text, /conversation_id: conv-123/);
  assert.match(text, /pi_session_id: pi-session-456/);
  assert.match(text, /api: \/api\/pi\/conversations\/conv-123/);
});

test('formats PI message debug info and falls back to conversation ids', () => {
  const text = formatPiMessageDebugInfo(
    { id: 'msg-1', role: 'assistant', created_at: '2026-07-08T02:00:00.000Z' },
    { id: 'conv-123', pi_session_id: 'pi-session-456', title: 'Need a fix' }
  );

  assert.match(text, /type: pi_message/);
  assert.match(text, /message_id: msg-1/);
  assert.match(text, /conversation_id: conv-123/);
  assert.match(text, /pi_session_id: pi-session-456/);
  assert.match(text, /conversation_title: Need a fix/);
});

test('formats PI chat errors for direct debug copying', () => {
  const text = formatPiErrorDebugInfo('network unavailable');

  assert.match(text, /type: pi_chat_error/);
  assert.match(text, /error: network unavailable/);
});
