import { useCallback, useEffect, useMemo, useRef } from 'react';
import { createPiChatTurnManager } from './piChatTurn';
import { usePiChatUnreadState, usePiChatFields, usePiChatLoader } from './piChatFields.js';
import { usePiChatRuntime } from './piChatRuntime.js';
import { useCreatePiConversation, useSendPiMessage, useStopPiMessage, clearPiTurnState } from './piChatMessageActions.js';

const RUNTIME_REFRESH_INTERVAL_MS = 5_000;

export function usePiChatState(initialConversationId = '', onConversationChange = null) {
  const state = usePiChatFields(onConversationChange);
  const unreadConversationIds = usePiChatUnreadState(state.filteredConversations, state.selectedConversationId);
  const initialSelectionRef = useRef('');
  const turnManager = useMemo(() => createPiChatTurnManager(), []);
  const {
    filteredConversations: conversations,
    loading,
  } = state;
  const loadPiState = usePiChatLoader({
    setConversations: state.setConversations,
    setError: state.setError,
    setLoading: state.setLoading,
    setProjects: state.setProjects,
    setSupervisor: state.setSupervisor
  });
  const runtime = usePiChatRuntime(state, turnManager);
  const createConversation = useCreatePiConversation(state);
  const sendMessage = useSendPiMessage(state, createConversation, loadPiState, turnManager);
  const stopMessage = useStopPiMessage(state, turnManager);
  const selectConversation = useCallback((id) => {
    if (turnManager.cancel('conversation_switch')) clearPiTurnState(state);
    return state.selectConversation(id);
  }, [state, turnManager]);

  useEffect(() => {
    loadPiState();
  }, [loadPiState]);

  useEffect(() => runtime.subscribe(), [runtime]);

  useEffect(() => {
    const interval = window.setInterval(runtime.reconcile, RUNTIME_REFRESH_INTERVAL_MS);
    const reconcileVisible = () => {
      if (document.visibilityState === 'visible') runtime.reconcile();
    };
    window.addEventListener('focus', runtime.reconcile);
    document.addEventListener('visibilitychange', reconcileVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', runtime.reconcile);
      document.removeEventListener('visibilitychange', reconcileVisible);
    };
  }, [runtime]);

  useEffect(() => () => {
    turnManager.cancel('unmount');
  }, [turnManager]);

  useEffect(() => {
    if (loading) return;
    const initialAvailable = conversations.some(conversation => conversation.id === initialConversationId);
    const preferredId = initialAvailable && initialConversationId !== state.selectedConversationId
      ? initialConversationId
      : !state.selectedConversationId
        ? conversations.find(conversation => conversation.runtime_status === 'running')?.id || ''
        : '';
    if (!preferredId || initialSelectionRef.current === preferredId) return;
    initialSelectionRef.current = preferredId;
    selectConversation(preferredId);
  }, [conversations, initialConversationId, loading, selectConversation, state.selectedConversationId]);

  return {
    ...state,
    conversations: state.filteredConversations,
    unreadConversationIds,
    handleConversationChange: selectConversation,
    handleCreateConversation: () => createConversation('New conversation', { notify: true }),
    handleSend: sendMessage,
    handleStop: stopMessage,
    loadPiState
  };
}
