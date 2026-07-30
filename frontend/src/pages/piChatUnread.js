export const PI_CHAT_READ_ACTIVITY_KEY = 'xuanwu.pi-chat.read-activity.v1';

export function piConversationActivityVersion(conversation = null) {
  const value = conversation?.last_activity_at || conversation?.updated_at || conversation?.created_at || '';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function parsePiChatReadActivity(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([id, timestamp]) => (
      Boolean(id) && Number.isFinite(timestamp) && timestamp >= 0
    )));
  } catch {
    return {};
  }
}

export function baselinePiChatReadActivity(current = {}, conversations = []) {
  let next = current;
  for (const conversation of Array.isArray(conversations) ? conversations : []) {
    if (!conversation?.id || Object.hasOwn(next, conversation.id)) continue;
    if (next === current) next = { ...current };
    next[conversation.id] = piConversationActivityVersion(conversation);
  }
  return next;
}

export function markPiChatConversationRead(current = {}, conversation = null) {
  if (!conversation?.id) return current;
  const activity = piConversationActivityVersion(conversation);
  if (current[conversation.id] === activity) return current;
  return { ...current, [conversation.id]: activity };
}

export function unreadPiConversationIds(conversations = [], selectedConversationId = '', readActivity = {}) {
  return new Set((Array.isArray(conversations) ? conversations : [])
    .filter((conversation) => {
      if (!conversation?.id || conversation.id === selectedConversationId) return false;
      const readVersion = readActivity[conversation.id];
      return Number.isFinite(readVersion) && piConversationActivityVersion(conversation) > readVersion;
    })
    .map((conversation) => conversation.id));
}
