import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { message } from '../store/toastStore';
import { defaultMessageSettings } from './sessions/sessionOptions';

const DEFAULT_TRANSCRIPT = [];
const DEFAULT_RUNNER_SETTINGS = {
  approvalPolicy: 'never',
  model: '',
  reasoningEffort: '',
  sandbox: 'workspace-write'
};

export function usePiChatState() {
  const state = usePiChatFields();
  const loadPiState = usePiChatLoader({
    setAgents: state.setAgents,
    setConversations: state.setConversations,
    setError: state.setError,
    setLoading: state.setLoading,
    setSelectedAgentId: state.setSelectedAgentId
  });
  const createConversation = useCreatePiConversation(state);
  const sendMessage = useSendPiMessage(state, createConversation, loadPiState);

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
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [messageSettings, setMessageSettings] = useState(() => defaultMessageSettings(DEFAULT_RUNNER_SETTINGS));
  const selectedAgent = useMemo(() => agents.find((agent) => agent.id === selectedAgentId), [agents, selectedAgentId]);
  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedConversationId) || null,
    [conversations, selectedConversationId]
  );
  const selectConversation = useCallback(async (id) => {
    setSelectedConversationId(id);
    setTranscript([]);
    if (!id) return;
    setLoading(true);
    try {
      const detail = await api.getPiConversation(id);
      setTranscript(conversationTranscript(detail));
      setError('');
    } catch (err) {
      setError(err.message || '读取 Runner 会话详情失败');
    } finally {
      setLoading(false);
    }
  }, []);
  const updateMessageSetting = useCallback((key, value) => {
    setMessageSettings((current) => ({ ...current, [key]: value }));
  }, []);
  return { agents, error, filteredConversations: conversations, loading, messageSettings, prompt, selectConversation,
    selectedAgent, selectedAgentId, selectedConversation, selectedConversationId, sending,
    setAgents, setConversations, setError, setLoading, setPrompt, setSelectedAgentId,
    setSelectedConversationId, setSending, setTranscript, transcript, updateMessageSetting };
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
    setSelectedAgentId
  } = setters;
  return useCallback(() => {
    setLoading(true);
    return Promise.all([api.getPiAgents(), api.getPiConversations()])
      .then(([agentList, conversationList]) => {
        setAgents(agentList || []);
        setConversations(conversationList || []);
        setError('');
        setSelectedAgentId((current) => current || firstEnabledAgent(agentList || [])?.id || '');
      })
      .catch((err) => setError(err.message || '读取 Runner 状态失败'))
      .finally(() => setLoading(false));
  }, [
    setAgents,
    setConversations,
    setError,
    setLoading,
    setSelectedAgentId
  ]);
}

function useCreatePiConversation(state) {
  return useCallback(async (title, options = {}) => {
    if (!ensureConversationInput(state.selectedAgentId)) return '';
    state.setSending(true);
    try {
      const conversation = await api.createPiConversation({
        pi_agent_id: state.selectedAgentId,
        title
      });
      state.setConversations((items) => [conversation, ...items]);
      state.setSelectedConversationId(conversation.id);
      state.setTranscript([]);
      if (options.notify) message.success('Runner 会话已创建');
      return conversation.id;
    } catch (err) {
      message.error(err.message || '创建 Runner 会话失败');
      return '';
    } finally {
      state.setSending(false);
    }
  }, [state]);
}

function useSendPiMessage(state, createConversation, loadPiState) {
  return useCallback(async (event) => {
    event.preventDefault();
    const text = state.prompt.trim();
    if (!text || state.sending) return;
    const conversationId = state.selectedConversationId || await createConversation('New conversation');
    if (!conversationId) return;
    await sendPromptToPi(state, conversationId, text, loadPiState);
  }, [createConversation, loadPiState, state]);
}

async function sendPromptToPi(state, conversationId, text, loadPiState) {
  state.setTranscript((items) => [...items, transcriptMessage('user', text)]);
  state.setPrompt('');
  state.setSending(true);
  try {
    const result = await api.sendPiConversationMessage(conversationId, { prompt: text, settings: runnerMessageSettings(state.messageSettings) });
    state.setTranscript((items) => [...items, transcriptMessage('assistant', runnerReplyText(result), result)]);
    applyConversationTitle(state, conversationId, result?.title);
    await loadPiState();
  } catch (err) {
    state.setTranscript((items) => [...items, transcriptMessage('error', err.message || '发送失败')]);
    message.error(err.message || '发送 Runner 消息失败');
  } finally {
    state.setSending(false);
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
  if (result?.status === 'failed') return 'Runner 执行失败，未返回错误详情';
  return 'Runner 未返回文本';
}

function runnerMessageSettings(settings) {
  return {
    approval_policy: settings.approvalPolicy,
    model: settings.model,
    reasoning_effort: settings.reasoningEffort,
    sandbox: settings.sandbox
  };
}

function ensureConversationInput(agentId) {
  if (!agentId) message.error('请先在 Settings 配置并启用 Runner Agent');
  return Boolean(agentId);
}

function transcriptMessage(role, text, meta = null) {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, meta, role, text };
}

function firstEnabledAgent(agents) {
  return Array.isArray(agents) ? agents.find((agent) => agent.enabled === 1) : null;
}

export function shortId(value) {
  const text = String(value || '');
  return text.length > 12 ? `${text.slice(0, 6)}…${text.slice(-4)}` : text;
}
