import { projectsApi } from '../api/projects.js';
import { assistantApi } from '../api/assistant.js';
import { PiConversationStreamError } from '../api/piConversationStream.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { message } from '../store/toastStore';
import { cleanProjectText, piChatMessageWithProjectContext, projectFromPrompt, referenceKey } from './piChatProjectContext';
import { appendPiTurnDelta, createPiChatTurnManager, hydrateCompletedPiTurn } from './piChatTurn';

const DEFAULT_TRANSCRIPT = [];
const STOP_RETRY_COUNT = 4;
const STOP_RETRY_DELAY_MS = 160;

export function usePiChatState(initialConversationId = '') {
  const state = usePiChatFields();
  const initialSelectionRef = useRef('');
  const turnManager = useMemo(() => createPiChatTurnManager(), []);
  const {
    conversations,
    loading,
  } = state;
  const loadPiState = usePiChatLoader({
    setConversations: state.setConversations,
    setError: state.setError,
    setLoading: state.setLoading,
    setProjects: state.setProjects,
    setSupervisor: state.setSupervisor
  });
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

  useEffect(() => () => {
    turnManager.cancel('unmount');
  }, [turnManager]);

  useEffect(() => {
    if (!initialConversationId || initialSelectionRef.current === initialConversationId || loading) return;
    if (!conversations.some(conversation => conversation.id === initialConversationId)) return;
    initialSelectionRef.current = initialConversationId;
    selectConversation(initialConversationId);
  }, [conversations, initialConversationId, loading, selectConversation]);

  return {
    ...state,
    conversations: state.filteredConversations,
    handleConversationChange: selectConversation,
    handleCreateConversation: () => createConversation('New conversation', { notify: true }),
    handleSend: sendMessage,
    handleStop: stopMessage,
    loadPiState
  };
}

function usePiChatFields() {
  const [supervisor, setSupervisor] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [selectedConversationId, setSelectedConversationId] = useState('');
  const [transcript, setTranscript] = useState(DEFAULT_TRANSCRIPT);
  const [prompt, setPrompt] = useState('');
  const [projects, setProjects] = useState([]);
  const [references, setReferences] = useState([]);
  const [runningConversationId, setRunningConversationId] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedConversationId) || null,
    [conversations, selectedConversationId]
  );
  const selectedProject = useMemo(
    () => selectedConversationProject(selectedConversation, references, projects),
    [projects, references, selectedConversation]
  );
  const selectConversation = useCallback(async (id) => {
    setSelectedConversationId(id);
    setTranscript([]);
    setReferences([]);
    if (!id) return;
    setLoading(true);
    try {
      const detail = await assistantApi.getPiConversation(id);
      setTranscript(conversationTranscript(detail));
      setError('');
    } catch (err) {
      setError(err.message || '读取 Chat 详情失败');
    } finally {
      setLoading(false);
    }
  }, []);
  const attachReference = useCallback((reference) => {
    setReferences((current) => addPiChatReference(current, reference));
  }, []);
  const removeReference = useCallback((key) => {
    setReferences((current) => current.filter((item) => referenceKey(item) !== key));
  }, []);
  return { attachReference, error, filteredConversations: conversations, loading, projects, prompt, references, removeReference, runningConversationId,
    selectConversation, selectedConversation, selectedConversationId, selectedProject, sending, stopping, supervisor,
    setConversations, setError, setLoading, setProjects, setPrompt, setReferences, setSupervisor,
    setSelectedConversationId, setRunningConversationId, setSending, setStopping, setTranscript, transcript };
}

function conversationTranscript(detail) {
  return Array.isArray(detail?.transcript)
    ? detail.transcript.map(normalizeTranscriptItem).filter(Boolean)
    : [];
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

function usePiChatLoader(setters) {
  const {
    setConversations,
    setError,
    setLoading,
    setProjects,
    setSupervisor
  } = setters;
  return useCallback(() => {
    setLoading(true);
    return Promise.all([assistantApi.getPiSupervisor(), assistantApi.getPiConversations(), projectsApi.getProjects()])
      .then(([supervisor, conversationList, projectList]) => {
        setSupervisor(supervisor || null);
        setConversations(conversationList || []);
        setProjects(projectList || []);
        setError('');
      })
      .catch((err) => setError(err.message || '读取 Chat 状态失败'))
      .finally(() => setLoading(false));
  }, [
    setConversations,
    setError,
    setLoading,
    setProjects,
    setSupervisor
  ]);
}

function useCreatePiConversation(state) {
  return useCallback(async (title, options = {}) => {
    state.setSending(true);
    try {
      const conversation = await assistantApi.createPiConversation({
        project_id: currentProjectId(state, options.project),
        title
      });
      state.setConversations((items) => [conversation, ...items]);
      state.setSelectedConversationId(conversation.id);
      state.setTranscript([]);
      state.setReferences([]);
      if (options.notify) message.success('Chat 已创建');
      return conversation.id;
    } catch {
      message.error('创建 Chat 失败，请重试');
      return '';
    } finally {
      state.setSending(false);
    }
  }, [state]);
}

function useSendPiMessage(state, createConversation, loadPiState, turnManager) {
  return useCallback(async (event) => {
    event.preventDefault();
    const text = state.prompt.trim();
    if (!text || state.sending) return;
    const targetProject = state.selectedProject || projectFromPrompt(text, state.projects);
    const conversationId = state.selectedConversationId
      || await createConversation('New conversation', { project: targetProject });
    if (!conversationId) return;
    await sendPromptToPi(state, conversationId, text, loadPiState, targetProject, turnManager);
  }, [createConversation, loadPiState, state, turnManager]);
}

function useStopPiMessage(state, turnManager) {
  return useCallback(async () => {
    const conversationId = state.runningConversationId;
    if (!state.sending || !conversationId || state.stopping) return;
    state.setStopping(true);
    try {
      const result = await interruptActivePiConversation(conversationId);
      if (result?.interrupted) {
        turnManager.cancel('stop');
        clearPiTurnState(state);
        message.success('已请求停止 Xuanwu');
        return;
      }
      state.setStopping(false);
      message.error('当前没有可停止的 Xuanwu 执行');
    } catch {
      state.setStopping(false);
      message.error('停止 Xuanwu 失败，请重试');
    }
  }, [state, turnManager]);
}

async function sendPromptToPi(state, conversationId, text, loadPiState, targetProject, turnManager) {
  const turn = turnManager.begin(conversationId);
  state.setTranscript((items) => [...items, transcriptMessage('user', text)]);
  state.setPrompt('');
  state.setRunningConversationId(conversationId);
  state.setSending(true);
  try {
    const result = await assistantApi.sendPiConversationMessage(
      conversationId,
      piChatMessageWithProjectContext(text, targetProject || state.selectedProject),
      {
        signal: turn.controller.signal,
        onEvent: (streamEvent) => applyPiTurnEvent(state, turnManager, turn, streamEvent),
      },
    );
    if (!turnManager.isCurrent(turn) || result?.status === 'aborted') return;
    applyConversationTitle(state, conversationId, result?.title);
    await hydrateConversationTranscript(
      state,
      conversationId,
      result,
      () => turnManager.isCurrent(turn),
    );
    if (!turnManager.isCurrent(turn)) return;
    await loadPiState();
  } catch (err) {
    if (!turnManager.isCurrent(turn)) return;
    const detail = piTurnErrorMessage(err);
    state.setTranscript((items) => [...items, transcriptMessage('error', detail, {
      background_running: Boolean(err?.backgroundRunning),
      recoverable: true,
      turn_id: err?.turnId || '',
    })]);
    message.error(detail);
  } finally {
    if (turnManager.finish(turn)) clearPiTurnState(state);
  }
}

function applyPiTurnEvent(state, turnManager, turn, streamEvent) {
  if (!turnManager.isCurrent(turn)) return;
  const { data, event, turnId } = streamEvent;
  if (event === 'accepted' || event === 'start') {
    state.setSending(true);
    return;
  }
  if (event === 'assistant_text_delta') {
    state.setTranscript((items) => appendPiTurnDelta(items, turnId, data.delta ?? data.text, turn.conversationId));
  }
}

function clearPiTurnState(state) {
  state.setRunningConversationId('');
  state.setSending(false);
  state.setStopping(false);
}

function piTurnErrorMessage(error) {
  if (error instanceof PiConversationStreamError) return error.message;
  if (error?.name === 'AbortError') return '消息流已关闭';
  return error?.message || '发送失败，请重试';
}

async function interruptActivePiConversation(conversationId) {
  let result = null;
  for (let attempt = 0; attempt <= STOP_RETRY_COUNT; attempt += 1) {
    result = await assistantApi.interruptPiConversation(conversationId);
    if (result?.interrupted || attempt === STOP_RETRY_COUNT) return result;
    await delay(STOP_RETRY_DELAY_MS);
  }
  return result;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function hydrateConversationTranscript(state, conversationId, fallbackResult = null, shouldApply = () => true) {
  try {
    await hydrateCompletedPiTurn({
      conversationId,
      getConversation: assistantApi.getPiConversation,
      isCurrent: shouldApply,
      onHydrated(detail) {
        state.setTranscript(conversationTranscript(detail));
        state.setError('');
      },
    });
  } catch {
    if (!shouldApply()) return;
    const text = runnerReplyText(fallbackResult);
    if (text) state.setTranscript((items) => [...items, transcriptMessage('assistant', text, fallbackResult)]);
  }
}

function applyConversationTitle(state, conversationId, title) {
  const text = String(title || '').trim();
  if (!text) return;
  state.setConversations((items) => items.map((item) => (
    item.id === conversationId ? { ...item, title: text } : item
  )));
}


function runnerReplyText(result) {
  const text = String(result?.text || '').trim();
  if (text) return text;
  if (result?.status === 'failed') return 'Xuanwu 执行失败，未返回错误详情';
  return 'Xuanwu 未返回内容';
}


function currentProjectId(state, project = null) {
  return project?.id || state.selectedProject?.id || '';
}

function selectedConversationProject(conversation, references, projects) {
  const referencedProject = references
    .map((reference) => reference.type === 'project' ? reference.id : '')
    .find(Boolean);
  const projectId = referencedProject || conversation?.project_id || '';
  return projects.find((project) => project.id === projectId) || null;
}

function addPiChatReference(current, reference) {
  const normalized = normalizeReference(reference);
  if (!normalized) return Array.isArray(current) ? current : [];
  const refs = Array.isArray(current) ? current : [];
  const withoutSameTypeProject = normalized.type === 'project'
    ? refs.filter((item) => item.type !== 'project')
    : refs;
  if (withoutSameTypeProject.some((item) => referenceKey(item) === referenceKey(normalized))) return withoutSameTypeProject;
  return [...withoutSameTypeProject, normalized];
}

function normalizeReference(reference) {
  const type = String(reference?.type || '').trim().toLowerCase();
  if (type !== 'project') return null;
  const id = cleanProjectText(reference.id);
  if (!id) return null;
  return {
    type,
    id,
    label: cleanProjectText(reference.label) || id,
    metadata: reference.metadata && typeof reference.metadata === 'object' ? { ...reference.metadata } : {},
  };
}

function transcriptMessage(role, text, meta = null) {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, meta, role, text };
}

export function shortId(value) {
  const text = String(value || '');
  return text.length > 12 ? `${text.slice(0, 6)}…${text.slice(-4)}` : text;
}
