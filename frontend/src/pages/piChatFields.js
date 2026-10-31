import { projectsApi } from '../api/projects.js';
import { assistantApi } from '../api/assistant.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cleanProjectText, referenceKey } from './piChatProjectContext';
import { sortPiConversationsByActivity } from './piChatPresentation';
import { baselinePiChatReadActivity, markPiChatConversationRead, parsePiChatReadActivity, PI_CHAT_READ_ACTIVITY_KEY, unreadPiConversationIds } from './piChatUnread';
import { applyConversationDetail } from './piChatRuntime.js';

const DEFAULT_TRANSCRIPT = [];

export function usePiChatUnreadState(conversations, selectedConversationId) {
  const [readActivity, setReadActivity] = useState(loadPiChatReadActivity);
  const selectedConversation = conversations.find((conversation) => conversation.id === selectedConversationId) || null;
  const selectedActivity = selectedConversation?.last_activity_at || selectedConversation?.updated_at || selectedConversation?.created_at || '';

  useEffect(() => {
    setReadActivity((current) => persistPiChatReadActivity(baselinePiChatReadActivity(current, conversations)));
  }, [conversations]);

  useEffect(() => {
    if (!selectedConversation) return;
    setReadActivity((current) => persistPiChatReadActivity(markPiChatConversationRead(current, selectedConversation)));
  }, [selectedActivity, selectedConversation]);

  return useMemo(
    () => unreadPiConversationIds(conversations, selectedConversationId, readActivity),
    [conversations, readActivity, selectedConversationId]
  );
}

function loadPiChatReadActivity() {
  if (typeof window === 'undefined') return {};
  try {
    return parsePiChatReadActivity(window.localStorage.getItem(PI_CHAT_READ_ACTIVITY_KEY));
  } catch {
    return {};
  }
}

function persistPiChatReadActivity(value) {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(PI_CHAT_READ_ACTIVITY_KEY, JSON.stringify(value));
  } catch {
    // Reading state is a progressive enhancement; storage restrictions must not block Chat.
  }
  return value;
}

export function usePiChatFields(onConversationChange) {
  const selectionRequestRef = useRef(0);
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
    const requestID = selectionRequestRef.current + 1;
    selectionRequestRef.current = requestID;
    setSelectedConversationId(id);
    onConversationChange?.(id);
    setTranscript([]);
    setReferences([]);
    if (!id) {
      setRunningConversationId('');
      setSending(false);
      setStopping(false);
      return;
    }
    setLoading(true);
    try {
      const detail = await assistantApi.getPiConversation(id);
      if (selectionRequestRef.current !== requestID) return;
      applyConversationDetail({
        detail,
        id,
        setRunningConversationId,
        setSending,
        setStopping,
        setTranscript,
      });
      setError('');
    } catch (err) {
      if (selectionRequestRef.current !== requestID) return;
      setError(err.message || '读取 Chat 详情失败');
    } finally {
      if (selectionRequestRef.current === requestID) setLoading(false);
    }
  }, [onConversationChange]);
  const attachReference = useCallback((reference) => {
    setReferences((current) => addPiChatReference(current, reference));
  }, []);
  const removeReference = useCallback((key) => {
    setReferences((current) => current.filter((item) => referenceKey(item) !== key));
  }, []);
  const notifyConversationChange = useCallback((id) => onConversationChange?.(id), [onConversationChange]);
  return { attachReference, error, filteredConversations: conversations, loading, notifyConversationChange, projects, prompt, references, removeReference, runningConversationId,
    selectConversation, selectedConversation, selectedConversationId, selectedProject, sending, stopping, supervisor,
    setConversations, setError, setLoading, setProjects, setPrompt, setReferences, setSupervisor,
    setSelectedConversationId, setRunningConversationId, setSending, setStopping, setTranscript, transcript };
}

export function usePiChatLoader(setters) {
  const {
    setConversations,
    setError,
    setLoading,
    setProjects,
    setSupervisor
  } = setters;
  return useCallback((options = {}) => {
    const background = Boolean(options.background);
    if (!background) setLoading(true);
    return Promise.all([assistantApi.getPiSupervisor(), assistantApi.getPiConversations(), projectsApi.getProjects()])
      .then(([supervisor, conversationList, projectList]) => {
        setSupervisor(supervisor || null);
        setConversations(sortPiConversationsByActivity(conversationList));
        setProjects(projectList || []);
        setError('');
      })
      .catch((err) => setError(err.message || '读取 Chat 状态失败'))
      .finally(() => {
        if (!background) setLoading(false);
      });
  }, [
    setConversations,
    setError,
    setLoading,
    setProjects,
    setSupervisor
  ]);
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
