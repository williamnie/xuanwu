import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { message } from '../store/toastStore';
import { clearPiLiveAssistant, setPiLiveConversation, usePiConversationEvents } from './piChatLiveBridge';
import { DEFAULT_PI_AGENT_ID } from './piAgentSettingsState';
import { cleanProjectText, projectFromPrompt, promptWithProjectContext, referenceKey } from './piChatProjectContext';

const DEFAULT_TRANSCRIPT = [];

export function usePiChatState() {
  const state = usePiChatFields();
  const liveRefs = usePiConversationEvents(state, state.selectedConversationId);
  const loadPiState = usePiChatLoader({
    setAgents: state.setAgents,
    setConversations: state.setConversations,
    setError: state.setError,
    setLoading: state.setLoading,
    setProjects: state.setProjects,
    setSelectedAgentId: state.setSelectedAgentId
  });
  const createConversation = useCreatePiConversation(state);
  const sendMessage = useSendPiMessage(state, createConversation, loadPiState, liveRefs);

  useEffect(() => {
    loadPiState();
  }, [loadPiState]);

  return {
    ...state,
    conversations: state.filteredConversations,
    handleConversationChange: state.selectConversation,
    handleCreateConversation: () => createConversation('New conversation', { notify: true }),
    handleSend: sendMessage,
    loadPiState
  };
}

function usePiChatFields() {
  const [agents, setAgents] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [selectedConversationId, setSelectedConversationId] = useState('');
  const [transcript, setTranscript] = useState(DEFAULT_TRANSCRIPT);
  const [prompt, setPrompt] = useState('');
  const [projects, setProjects] = useState([]);
  const [references, setReferences] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const selectedAgent = useMemo(() => agents.find((agent) => agent.id === selectedAgentId), [agents, selectedAgentId]);
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
      const detail = await api.getPiConversation(id);
      setTranscript(conversationTranscript(detail));
      setError('');
    } catch (err) {
      setError(err.message || '读取 Assistant 会话详情失败');
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
  return { agents, attachReference, error, filteredConversations: conversations, loading, projects, prompt, references, removeReference, selectConversation,
    selectedAgent, selectedAgentId, selectedConversation, selectedConversationId, selectedProject, sending,
    setAgents, setConversations, setError, setLoading, setProjects, setPrompt, setReferences, setSelectedAgentId,
    setSelectedConversationId, setSending, setTranscript, transcript };
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
    id: item.id || `${role}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    meta: item.meta || null,
    role,
    text,
  };
}

function usePiChatLoader(setters) {
  const {
    setAgents,
    setConversations,
    setError,
    setLoading,
    setProjects,
    setSelectedAgentId
  } = setters;
  return useCallback(() => {
    setLoading(true);
    return Promise.all([api.getPiAgents(), api.getPiConversations(), api.getProjects()])
      .then(([agentList, conversationList, projectList]) => {
        setAgents(agentList || []);
        setConversations(conversationList || []);
        setProjects(projectList || []);
        setError('');
        setSelectedAgentId(defaultRuntimeAgent(agentList || [])?.id || '');
      })
      .catch((err) => setError(err.message || '读取 Assistant 状态失败'))
      .finally(() => setLoading(false));
  }, [
    setAgents,
    setConversations,
    setError,
    setLoading,
    setProjects,
    setSelectedAgentId
  ]);
}

function useCreatePiConversation(state) {
  return useCallback(async (title, options = {}) => {
    state.setSending(true);
    try {
      const conversation = await api.createPiConversation({
        project_id: currentProjectId(state, options.project),
        title
      });
      state.setConversations((items) => [conversation, ...items]);
      state.setSelectedConversationId(conversation.id);
      state.setTranscript([]);
      state.setReferences([]);
      if (options.notify) message.success('Assistant 会话已创建');
      return conversation.id;
    } catch (err) {
      message.error(err.message || '创建 Assistant 会话失败');
      return '';
    } finally {
      state.setSending(false);
    }
  }, [state]);
}

function useSendPiMessage(state, createConversation, loadPiState, liveRefs) {
  return useCallback(async (event) => {
    event.preventDefault();
    const text = state.prompt.trim();
    if (!text || state.sending) return;
    const targetProject = state.selectedProject || projectFromPrompt(text, state.projects);
    const shouldCreateProjectConversation = targetProject?.id && state.selectedConversation?.project_id !== targetProject.id;
    const conversationId = shouldCreateProjectConversation
      ? await createConversation('New conversation', { project: targetProject })
      : state.selectedConversationId || await createConversation('New conversation', { project: targetProject });
    if (!conversationId) return;
    await sendPromptToPi(state, conversationId, text, loadPiState, targetProject, liveRefs);
  }, [createConversation, liveRefs, loadPiState, state]);
}

async function sendPromptToPi(state, conversationId, text, loadPiState, targetProject = null, liveRefs = null) {
  setPiLiveConversation(liveRefs, conversationId);
  state.setTranscript((items) => [...items, transcriptMessage('user', text)]);
  state.setPrompt('');
  state.setSending(true);
  try {
    const result = await api.sendPiConversationMessage(conversationId, { prompt: promptWithProjectContext(text, targetProject || state.selectedProject) });
    applyConversationTitle(state, conversationId, result?.title);
    await loadPiState();
    await hydrateConversationTranscript(state, conversationId, result);
  } catch (err) {
    state.setTranscript((items) => [...items, transcriptMessage('error', err.message || '发送失败')]);
    message.error(err.message || '发送 Assistant 消息失败');
  } finally {
    clearPiLiveAssistant(liveRefs);
    state.setSending(false);
  }
}

async function hydrateConversationTranscript(state, conversationId, fallbackResult = null) {
  try {
    const detail = await api.getPiConversation(conversationId);
    state.setTranscript(conversationTranscript(detail));
    state.setError('');
  } catch {
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
  if (result?.status === 'failed') return 'PI Assistant 执行失败，未返回错误详情';
  return 'PI Assistant 未返回文本';
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

function defaultRuntimeAgent(agents) {
  if (!Array.isArray(agents)) return null;
  return agents.find((agent) => agent.id === DEFAULT_PI_AGENT_ID)
    || agents.find((agent) => agent.enabled === 1)
    || agents[0]
    || null;
}

export function shortId(value) {
  const text = String(value || '');
  return text.length > 12 ? `${text.slice(0, 6)}…${text.slice(-4)}` : text;
}
