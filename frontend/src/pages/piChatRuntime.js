import { assistantApi } from '../api/assistant.js';
import { eventsApi } from '../api/events.js';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { sortPiConversationsByActivity } from './piChatPresentation';
import { applyPiConversationActivityEvent, isPiRuntimeEvent, isPiTerminalEvent, isPiTextDeltaEvent, piConversationDetailState } from './piChatRuntimeState';
import { appendPiTurnDelta } from './piChatTurn';

export function applyConversationDetail(setters) {
  const { detail, id } = setters;
  const restored = piConversationDetailState(detail, id);
  setters.setTranscript(restored.transcript);
  setters.setRunningConversationId(restored.runningConversationId);
  setters.setSending(restored.sending);
  setters.setStopping(false);
}

export function usePiChatRuntime(state, turnManager) {
  const {
    setConversations,
    setRunningConversationId,
    setSending,
    setStopping,
    setTranscript,
  } = state;
  const terminalReconcileTimerRef = useRef(0);
  const selectedConversationIdRef = useLatestRef(state.selectedConversationId);
  const runningConversationIdRef = useLatestRef(state.runningConversationId);
  const reconcile = useCallback(async () => {
    try {
      const conversations = sortPiConversationsByActivity(await assistantApi.getPiConversations());
      setConversations(conversations);
      const id = selectedConversationIdRef.current;
      if (!id) return;
      const current = conversations.find((conversation) => conversation.id === id);
      const ownsDirectStream = turnManager.current()?.conversationId === id;
      if (ownsDirectStream) return;
      if (current?.runtime_status !== 'running' && runningConversationIdRef.current !== id) return;
      const detail = await assistantApi.getPiConversation(id);
      if (selectedConversationIdRef.current !== id || turnManager.current()?.conversationId === id) return;
      applyConversationDetail({
        detail,
        id,
        setRunningConversationId,
        setSending,
        setStopping,
        setTranscript,
      });
    } catch {
      // Background reconciliation is best-effort; the explicit refresh path reports errors.
    }
  }, [
    runningConversationIdRef,
    selectedConversationIdRef,
    setConversations,
    setRunningConversationId,
    setSending,
    setStopping,
    setTranscript,
    turnManager,
  ]);
  const subscribe = useCallback(() => {
    const unsubscribe = eventsApi.subscribeToEvents((event) => {
      if (event?.type !== 'pi.conversation.event' || !event.conversationId) return;
      setConversations((items) => applyPiConversationActivityEvent(items, event));
      const id = event.conversationId;
      if (selectedConversationIdRef.current !== id || turnManager.current()?.conversationId === id) return;
      if (isPiRuntimeEvent(event)) {
        setRunningConversationId(id);
        setSending(true);
      }
      if (isPiTextDeltaEvent(event)) {
        setTranscript((items) => appendPiTurnDelta(items, event.turnId, event.text, id));
      }
      if (isPiTerminalEvent(event)) {
        setRunningConversationId('');
        setSending(false);
        setStopping(false);
        window.clearTimeout(terminalReconcileTimerRef.current);
        terminalReconcileTimerRef.current = window.setTimeout(reconcile, 120);
      }
    }, reconcile, reconcile);
    return () => {
      unsubscribe();
      window.clearTimeout(terminalReconcileTimerRef.current);
    };
  }, [
    reconcile,
    selectedConversationIdRef,
    setConversations,
    setRunningConversationId,
    setSending,
    setStopping,
    setTranscript,
    terminalReconcileTimerRef,
    turnManager,
  ]);
  return useMemo(() => ({ reconcile, subscribe }), [reconcile, subscribe]);
}

function useLatestRef(value) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
