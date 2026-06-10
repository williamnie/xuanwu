import { useEffect, useRef } from 'react';
import { api } from '../api/client';
import {
  appendPiAssistantDelta,
  endsPiAssistantMessage,
  isPiRunEndEvent,
  isPiRunStartEvent,
  isSelectedPiConversationEvent,
  startsPiAssistantMessage,
  visiblePiAssistantDelta,
} from './piChatLiveEvents';

export function usePiConversationEvents(state, selectedConversationId) {
  const liveRefs = useRef({ assistantId: '', conversationId: '' });
  const stateRef = useRef(state);

  useEffect(() => {
    stateRef.current = state;
  });
  useEffect(() => {
    liveRefs.current.conversationId = selectedConversationId || '';
  }, [selectedConversationId]);
  useEffect(() => api.subscribeToEvents((event) => {
    const live = liveRefs.current;
    if (!isSelectedPiConversationEvent(event, live.conversationId)) return;
    applyPiConversationEvent(stateRef.current, event, live);
  }), []);

  return liveRefs;
}

export function setPiLiveConversation(liveRefs, conversationId) {
  if (!liveRefs?.current) return;
  liveRefs.current.conversationId = conversationId || '';
  liveRefs.current.assistantId = '';
}

export function clearPiLiveAssistant(liveRefs) {
  if (liveRefs?.current) liveRefs.current.assistantId = '';
}

function applyPiConversationEvent(state, event, live) {
  if (isPiRunStartEvent(event)) {
    state.setSending(true);
    return;
  }
  if (startsPiAssistantMessage(event)) {
    live.assistantId = liveAssistantId(event);
    return;
  }
  const delta = visiblePiAssistantDelta(event);
  if (delta) {
    const itemId = live.assistantId || liveAssistantId(event);
    live.assistantId = itemId;
    state.setTranscript((items) => appendPiAssistantDelta(items, itemId, delta, event));
    return;
  }
  if (endsPiAssistantMessage(event)) {
    live.assistantId = '';
    return;
  }
  if (isPiRunEndEvent(event)) state.setSending(false);
}

function liveAssistantId(event) {
  return [
    'live-assistant',
    event?.conversationId || 'conversation',
    event?.created_at || Date.now(),
  ].join('-');
}
