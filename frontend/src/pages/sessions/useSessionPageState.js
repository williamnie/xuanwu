import { useDataStore, selectProjects, selectRefreshData, selectSetProjects } from '../../store/dataStore';
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { defaultSessionSettings, defaultMessageSettings } from './sessionOptions';
import { readQueuedSessionMessages, visibleApprovalsForSession, canSteerSessionProvider, persistQueuedSessionMessages } from './sessionPageRuntime';

export default function useSessionPageState({
  showSidebar,
  autoSelectFirstSession,
  selectedSessionId,
}) {
  const projects = useDataStore(selectProjects);
  const refreshData = useDataStore(selectRefreshData);
  const setProjects = useDataStore(selectSetProjects);
  const [sessions, setSessions] = useState([]);
  const [cursor, setCursor] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [selectedSession, setSelectedSession] = useState(null);
  const [turnCursor, setTurnCursor] = useState('');
  const [turnsLoading, setTurnsLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [loading, setLoading] = useState(showSidebar);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [cwd, setCwd] = useState('');
  const [lastProjectId, setLastProjectId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [promptReferences, setPromptReferences] = useState([]);
  const [sessionSettings, setSessionSettings] = useState(() => defaultSessionSettings(null));
  const [messageSettings, setMessageSettings] = useState(() => defaultMessageSettings(null));
  const [models, setModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [providerRuntimeStatus, setProviderRuntimeStatus] = useState(null);
  const [providerCatalog, setProviderCatalog] = useState([]);
  const [message, setMessage] = useState('');
  const [messageReferences, setMessageReferences] = useState([]);
  const [messageCommand, setMessageCommand] = useState(null);
  const [messageCommandResult, setMessageCommandResult] = useState(null);
  const [messageCommandError, setMessageCommandError] = useState('');
  const [commandExecuting, setCommandExecuting] = useState(false);
  const [promptCommand, setPromptCommand] = useState(null);
  const [promptCommandResult, setPromptCommandResult] = useState(null);
  const [promptCommandError, setPromptCommandError] = useState('');
  const [sending, setSending] = useState(false);
  const [liveEvents, setLiveEvents] = useState([]);
  const [sessionRunning, setSessionRunning] = useState(false);
  const [followRunningTurn, setFollowRunningTurn] = useState(true);
  const [interruptState, setInterruptState] = useState(null);
  const [messageQueue, setMessageQueue] = useState(readQueuedSessionMessages);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState([]);
  const [approvalQueue, setApprovalQueue] = useState([]);
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const [savingProjectOrder, setSavingProjectOrder] = useState(false);
  const selectedIdRef = useRef(selectedId);
  const ignorePropSelectionRef = useRef(false);
  const autoSelectFirstSessionRef = useRef(autoSelectFirstSession);
  const interruptStateRef = useRef(interruptState);
  const messageQueueRef = useRef(messageQueue);
  const providerSelectionTouchedRef = useRef(false);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    interruptStateRef.current = interruptState;
  }, [interruptState]);

  const applyInterruptNotice = useCallback((notice) => {
    interruptStateRef.current = notice;
    setInterruptState(notice);
  }, []);

  useEffect(() => {
    if (ignorePropSelectionRef.current && !selectedSessionId) {
      ignorePropSelectionRef.current = false;
      return;
    }
    if (ignorePropSelectionRef.current) return;
    if (selectedSessionId && selectedSessionId !== selectedIdRef.current) {
      setSelectedId(selectedSessionId);
    }
  }, [selectedSessionId]);

  const currentApprovals = useMemo(() => visibleApprovalsForSession(approvalQueue, selectedId), [approvalQueue, selectedId]);
  const approvalRequest = currentApprovals[0]?.request || null;
  const currentQueuedMessages = useMemo(
    () => messageQueue.filter((item) => item.sessionId === selectedId),
    [messageQueue, selectedId],
  );
  const selectedDetailReady = selectedSession?.id === selectedId;
  const canSteerSelected = canSteerSessionProvider(selectedSession?.provider || selectedId.split(':')[0], selectedSession?.native_terminal?.mode);

  useEffect(() => {
    messageQueueRef.current = messageQueue;
    persistQueuedSessionMessages(messageQueue);
  }, [messageQueue]);

  const [activeView, setActiveView] = useState('chat');

  useEffect(() => {
    if (selectedId) {
      setActiveView('chat');
    } else {
      setActiveView('new');
    }
  }, [selectedId]);

  return {
    projects,
    refreshData,
    setProjects,
    sessions,
    setSessions,
    cursor,
    setCursor,
    selectedId,
    setSelectedId,
    selectedSession,
    setSelectedSession,
    turnCursor,
    setTurnCursor,
    turnsLoading,
    setTurnsLoading,
    detailError,
    setDetailError,
    loading,
    setLoading,
    detailLoading,
    setDetailLoading,
    loadingMore,
    setLoadingMore,
    projectId,
    setProjectId,
    cwd,
    setCwd,
    lastProjectId,
    setLastProjectId,
    prompt,
    setPrompt,
    promptReferences,
    setPromptReferences,
    sessionSettings,
    setSessionSettings,
    messageSettings,
    setMessageSettings,
    models,
    setModels,
    modelsLoading,
    setModelsLoading,
    modelsError,
    setModelsError,
    providerRuntimeStatus,
    setProviderRuntimeStatus,
    providerCatalog,
    setProviderCatalog,
    message,
    setMessage,
    messageReferences,
    setMessageReferences,
    messageCommand,
    setMessageCommand,
    messageCommandResult,
    setMessageCommandResult,
    messageCommandError,
    setMessageCommandError,
    commandExecuting,
    setCommandExecuting,
    promptCommand,
    setPromptCommand,
    promptCommandResult,
    setPromptCommandResult,
    promptCommandError,
    setPromptCommandError,
    sending,
    setSending,
    liveEvents,
    setLiveEvents,
    sessionRunning,
    setSessionRunning,
    followRunningTurn,
    setFollowRunningTurn,
    interruptState,
    setInterruptState,
    messageQueue,
    setMessageQueue,
    optimisticUserMessages,
    setOptimisticUserMessages,
    approvalQueue,
    setApprovalQueue,
    approvalSubmitting,
    setApprovalSubmitting,
    savingProjectOrder,
    setSavingProjectOrder,
    selectedIdRef,
    ignorePropSelectionRef,
    autoSelectFirstSessionRef,
    interruptStateRef,
    messageQueueRef,
    providerSelectionTouchedRef,
    applyInterruptNotice,
    currentApprovals,
    approvalRequest,
    currentQueuedMessages,
    selectedDetailReady,
    canSteerSelected,
    activeView,
    setActiveView,
  };
}
