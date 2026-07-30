import { sortPiConversationsByActivity } from './piChatPresentation.js';
import { replacePiTurnText } from './piChatTurn.js';

export function conversationTranscript(detail) {
  return Array.isArray(detail?.transcript)
    ? detail.transcript.map(normalizeTranscriptItem).filter(Boolean)
    : [];
}

export function piConversationDetailState(detail, id) {
  const running = detail?.runtime_status === 'running';
  let transcript = conversationTranscript(detail);
  if (running) transcript = replacePiTurnText(transcript, detail.active_turn_id, detail.active_text, id);
  return {
    runningConversationId: running ? id : '',
    sending: running,
    transcript,
  };
}

export function applyPiConversationActivityEvent(items, event) {
  const conversations = Array.isArray(items) ? items : [];
  const next = conversations.map((conversation) => {
    if (conversation.id !== event.conversationId) return conversation;
    const terminal = isPiTerminalEvent(event);
    return {
      ...conversation,
      active_turn_id: terminal ? '' : event.turnId || conversation.active_turn_id || '',
      last_activity_at: event.created_at || new Date().toISOString(),
      runtime_status: terminal ? 'idle' : 'running',
    };
  });
  return sortPiConversationsByActivity(next);
}

export function isPiRuntimeEvent(event) {
  return !isPiTerminalEvent(event) && ['agent_start', 'message_start', 'message_update', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(event.agent_event_type);
}

export function isPiTerminalEvent(event) {
  return event.agent_event_type === 'agent_end' && event.status !== 'retrying';
}

export function isPiTextDeltaEvent(event) {
  if (event.agent_event_type !== 'message_update' || !event.text) return false;
  try {
    return JSON.parse(event.payload || '{}').assistant_event_type === 'text_delta';
  } catch {
    return false;
  }
}

function normalizeTranscriptItem(item) {
  const role = ['assistant', 'error', 'user'].includes(item?.role) ? item.role : '';
  const text = String(item?.text || '').trim();
  if (!role || !text) return null;
  return {
    created_at: item.created_at || '',
    id: item.id || `${role}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    meta: item.meta || null,
    role,
    text,
  };
}
