const PI_CONVERSATION_EVENT = 'pi.conversation.event';

export function piChatEventPayload(event) {
  if (!event?.payload) return {};
  try {
    const parsed = JSON.parse(event.payload);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function isSelectedPiConversationEvent(event, conversationId) {
  const selectedId = String(conversationId || '').trim();
  return Boolean(selectedId) &&
    event?.type === PI_CONVERSATION_EVENT &&
    String(event.conversationId || '') === selectedId;
}

export function isPiRunStartEvent(event) {
  return event?.agent_event_type === 'agent_start';
}

export function isPiRunEndEvent(event) {
  return event?.agent_event_type === 'agent_end';
}

export function startsPiAssistantMessage(event) {
  const payload = piChatEventPayload(event);
  return event?.agent_event_type === 'message_start' && payload.role === 'assistant';
}

export function endsPiAssistantMessage(event) {
  const payload = piChatEventPayload(event);
  return event?.agent_event_type === 'message_end' && payload.role === 'assistant';
}

export function visiblePiAssistantDelta(event) {
  const payload = piChatEventPayload(event);
  if (event?.agent_event_type !== 'message_update') return '';
  if (payload.role !== 'assistant') return '';
  if (payload.assistant_event_type !== 'text_delta') return '';
  return String(event.text || '');
}

export function appendPiAssistantDelta(items, id, delta, event) {
  const text = String(delta || '');
  const itemId = String(id || '').trim();
  if (!text || !itemId) return Array.isArray(items) ? items : [];
  const current = Array.isArray(items) ? items : [];
  let updated = false;
  const next = current.map((item) => {
    if (item.id !== itemId) return item;
    updated = true;
    return { ...item, text: `${item.text || ''}${text}` };
  });
  if (updated) return next;
  return [...current, liveAssistantMessage(itemId, text, event)];
}

function liveAssistantMessage(id, text, event) {
  return {
    id,
    role: 'assistant',
    text,
    meta: {
      conversation_id: event?.conversationId || '',
      live: true,
    },
  };
}
