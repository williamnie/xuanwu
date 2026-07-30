import assert from 'node:assert/strict';
import test from 'node:test';

import {
  baselinePiChatReadActivity,
  markPiChatConversationRead,
  parsePiChatReadActivity,
  unreadPiConversationIds,
} from './piChatUnread.js';

const conversations = [
  { id: 'selected', last_activity_at: '2026-07-30T01:00:00Z' },
  { id: 'background', last_activity_at: '2026-07-30T01:00:00Z' },
];

test('Chat read activity starts from the current history without marking every old conversation unread', () => {
  const baseline = baselinePiChatReadActivity({}, conversations);
  assert.deepEqual([...unreadPiConversationIds(conversations, '', baseline)], []);
});

test('Chat unread state appears after background activity and clears when opened', () => {
  const baseline = baselinePiChatReadActivity({}, conversations);
  const updated = conversations.map((conversation) => conversation.id === 'background'
    ? { ...conversation, last_activity_at: '2026-07-30T01:01:00Z' }
    : conversation);

  assert.deepEqual([...unreadPiConversationIds(updated, 'selected', baseline)], ['background']);
  const read = markPiChatConversationRead(baseline, updated[1]);
  assert.deepEqual([...unreadPiConversationIds(updated, 'background', read)], []);
});

test('Chat read activity safely ignores malformed persisted values', () => {
  assert.deepEqual(parsePiChatReadActivity('{bad json'), {});
  assert.deepEqual(parsePiChatReadActivity('{"chat":123,"bad":"now"}'), { chat: 123 });
});
