import { systemApi } from '../api/system.js';
import { projectsApi } from '../api/projects.js';
import { runsApi } from '../api/runs.js';
import { eventsApi } from '../api/events.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { message as toast } from '../store/toastStore';
import { selectProjects, selectRefreshData, selectSetProjects, useDataStore } from '../store/dataStore';
import {
  enqueueApprovalNotice,
  hasApprovalForSession,
  removeApprovalRequest,
  removeApprovalsForSession,
  syncApprovalsForSession,
} from './sessions/approvalQueue';
import {
  createQueuedSessionMessage,
  enqueueQueuedSessionMessage,
  markQueuedSessionMessageFailed,
  markQueuedSessionMessageSending,
  nextPendingQueuedSessionMessage,
  removeQueuedSessionMessage,
  retryQueuedSessionMessage,
} from './sessions/sessionMessageQueue';
import { PROJECT_REQUIRED_MESSAGE, canCreateSession, readySessionProviders, resolveLastSessionProject } from './sessions/newSessionGuards';
import { buildRunnerCommandRequest, clearSessionCommandState, validateSessionCommand } from './sessions/sessionCommands';
import { availableProviderModelValue, defaultMessageSettings, defaultSessionSettings, sessionSettingsForProject, sessionSettingsForProvider } from './sessions/sessionOptions';
import { orderedProjectsAfterMove } from './sessions/projectOrder';
import { messageSettingsForRuntimeKey } from './sessions/sessionRuntimeSettings';
import { hasComposerContent, sessionPayloadWithReferences } from './sessions/sessionReferences';
import {
  interruptCompletionNotice,
  interruptFailureNotice,
  interruptRequestNotice,
  isInterruptPendingForSession,
  isSessionStopEvent,
} from './sessions/sessionInterrupt';
import {
  createOptimisticSessionUserMessage,
  reconcileOptimisticSessionUserMessages,
} from './sessions/sessionOptimisticMessages';
import SessionSidebar from './sessions/SessionSidebar';
import SessionWorkspace from './sessions/SessionWorkspace';
import useSessionPageSelectors from './sessions/useSessionPageSelectors';
import {
  chronologicalTurns,
  eventSessionKey,
  eventSessionKeyFromPayload,
  isAgentEvent,
  isSessionFileEvent,
  isSessionRunning,
  isSessionStartEvent,
  mergeRefreshedSessions,
  mergeTurnPages,
  mergeSessions,
  normalizePendingApprovals,
  parseApprovalPayload,
  parseApprovalResolvedPayload,
  persistQueuedSessionMessages,
  providerSessionKey,
  queuedMessageId,
  readQueuedSessionMessages,
  sessionIDFromCreateResult,
  sessionFromCreateResult,
  setSessionRunningInList,
  syncSessionRuntimeInList,
  upsertRunningSessionFromEvent,
  visibleApprovalsForSession,
} from './sessions/sessionPageRuntime';
import './sessions/Sessions.css';
import './sessions/SessionsClient.css';

const PAGE_SIZE = 50;
const SESSION_DETAIL_REFRESH_DELAY_MS = 250;
const SESSION_LIST_REFRESH_DELAY_MS = 800;
const SESSION_TURN_PAGE_SIZE = 20;
const PROVIDER_MODELS_TIMEOUT_MS = 15_000;

export default function Sessions({
  autoSelectFirstSession = true,
  navigateTo,
  observationNotice = '',
  selectedSessionId = '',
  showEvidence = true,
  showSidebar = true,
  keepNewSessionRoute = false,
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
  const detailRefreshTimer = useRef(null);
  const listRefreshTimer = useRef(null);
  const selectedIdRef = useRef(selectedId);
  const lastSelectedIdRef = useRef(selectedId);
  const ignorePropSelectionRef = useRef(false);
  const autoSelectFirstSessionRef = useRef(autoSelectFirstSession);
  const interruptStateRef = useRef(interruptState);
  const messageQueueRef = useRef(messageQueue);
  const activeQueuedSendsRef = useRef(new Set());
  const providerSelectionTouchedRef = useRef(false);
  const modelRequestRef = useRef(0);
  const detailRequestRef = useRef(null);
  const turnsRequestRef = useRef(null);

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

  const {
    sessionProjects,
    selectedProject,
    selectedSessionProject,
    sessionComposerSuggestions,
    newSessionReferenceDetails,
    messageReferenceDetails,
    newSessionReferenceValidation,
    messageReferenceValidation,
    newCommandContext,
    messageCommandContext,
    selectedSessionRuntimeKey,
  } = useSessionPageSelectors({
    projects,
    selectedSession,
    projectId,
    prompt,
    promptReferences,
    message,
    messageReferences,
    selectedId,
  });

  useEffect(() => {
    refreshData(['projects']);
  }, [refreshData]);

  const loadFirstPage = useCallback(async ({
    silent = false,
    preserveLoaded = false,
    reportErrors = true,
  } = {}) => {
    if (!silent) setLoading(true);
    try {
      const result = await runsApi.getSessions({ limit: PAGE_SIZE });
      const data = result.data || [];
      const nextCursor = result.nextCursor || '';
      setSessions((current) => (
        preserveLoaded ? mergeRefreshedSessions(current, data) : data
      ));
      setCursor(nextCursor);
      setSelectedId((current) => current || (autoSelectFirstSessionRef.current ? data[0]?.id || '' : ''));
      autoSelectFirstSessionRef.current = false;
    } catch (err) {
      if (reportErrors) toast.error(err.message || '加载 provider sessions 失败');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await runsApi.getSessions({ limit: PAGE_SIZE, cursor });
      setSessions((prev) => mergeSessions(prev, result.data || []));
      setCursor(result.nextCursor || '');
    } catch (err) {
      toast.error(err.message || '继续加载 sessions 失败');
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore]);

  const loadSelected = useCallback(async (isSwitching = false, { refreshTranscript = false } = {}) => {
    if (!selectedId) return;
    if (detailRequestRef.current?.requestId === selectedId) return detailRequestRef.current.promise;
    if (isSwitching) {
      setDetailLoading(true);
      setSelectedSession(null);
      setTurnCursor('');
      setDetailError('');
    }
    const requestId = selectedId;
    const promise = (async () => {
      const [detail, turnPage] = await Promise.all([
        runsApi.getSession(requestId),
        refreshTranscript
          ? runsApi.getSessionTurns(requestId, { limit: SESSION_TURN_PAGE_SIZE })
          : Promise.resolve(null),
      ]);
      if (selectedIdRef.current !== requestId) return;
      const running = isSessionRunning(detail);
      const pageTurns = turnPage ? chronologicalTurns(turnPage.data) : null;
      setSelectedSession((current) => ({
        ...detail,
        turns: pageTurns ?? (current?.id === requestId ? current.turns || [] : []),
      }));
      if (turnPage) setTurnCursor(turnPage.nextCursor || '');
      setDetailError('');
      setSessionRunning(running);
      setSessions((prev) => syncSessionRuntimeInList(prev, detail, running));
      setApprovalQueue((current) => syncApprovalsForSession(
        current,
        requestId,
        normalizePendingApprovals(detail.pending_approvals),
      ));
    })();
    detailRequestRef.current = { promise, requestId };
    try {
      await promise;
    } catch (err) {
      if (selectedIdRef.current !== requestId) return;
      const message = err.message || '读取 session 详情失败';
      setDetailError(message);
      toast.error(message);
    } finally {
      if (detailRequestRef.current?.promise === promise) detailRequestRef.current = null;
      if (selectedIdRef.current === requestId) {
        setDetailLoading(false);
      }
    }
  }, [selectedId]);

  const loadOlderTurns = useCallback(async () => {
    if (!selectedId || !turnCursor || turnsRequestRef.current) return;
    const requestId = selectedId;
    setTurnsLoading(true);
    const promise = runsApi.getSessionTurns(requestId, {
      cursor: turnCursor,
      limit: SESSION_TURN_PAGE_SIZE,
    });
    turnsRequestRef.current = promise;
    try {
      const page = await promise;
      if (selectedIdRef.current !== requestId) return;
      const older = chronologicalTurns(page.data);
      setSelectedSession((current) => current?.id === requestId
        ? { ...current, turns: mergeTurnPages(older, current.turns || []) }
        : current);
      setTurnCursor(page.nextCursor || '');
    } catch (err) {
      if (selectedIdRef.current === requestId) toast.error(err.message || '读取更早记录失败');
    } finally {
      if (turnsRequestRef.current === promise) turnsRequestRef.current = null;
      if (selectedIdRef.current === requestId) setTurnsLoading(false);
    }
  }, [selectedId, turnCursor]);

  const loadModels = useCallback(async (provider = 'codex', runtimeStatus = null) => {
    const requestId = modelRequestRef.current + 1;
    modelRequestRef.current = requestId;
    if (!provider) {
      setModels([]);
      setModelsError('');
      setModelsLoading(false);
      return;
    }
    setModelsLoading(true);
    setModels([]);
    setModelsError('');
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), PROVIDER_MODELS_TIMEOUT_MS);
    try {
      const result = await systemApi.getProviderModels(provider, { signal: controller.signal });
      const data = Array.isArray(result?.data?.data) ? result.data.data : result?.data;
      if (modelRequestRef.current !== requestId) return;
      setModels(Array.isArray(data) ? data : []);
      setModelsError('');
    } catch (err) {
      if (modelRequestRef.current !== requestId) return;
      const providerStatus = (runtimeStatus?.providers || []).find(item => item.id === provider);
      const defaultModel = String(providerStatus?.default_model || '').trim();
      setModels(defaultModel ? [{ id: defaultModel, displayName: defaultModel, isDefault: true }] : []);
      setModelsError(err.name === 'AbortError' ? `读取 ${provider} 模型列表超时` : err.message || `读取 ${provider} 模型列表失败`);
    } finally {
      window.clearTimeout(timeout);
      if (modelRequestRef.current === requestId) setModelsLoading(false);
    }
  }, []);



  useEffect(() => {
    if (showSidebar) loadFirstPage();
    else setLoading(false);
  }, [loadFirstPage, showSidebar]);
  useEffect(() => {
    let alive = true;
    runsApi.getSessionPreferences()
      .then((prefs) => {
        if (alive) setLastProjectId(prefs?.last_project_id || '');
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (projectId || !lastProjectId) return;
    const project = resolveLastSessionProject(sessionProjects, lastProjectId);
    if (!project) return;
    setProjectId(project.id);
    setCwd(project.cwd);
    setSessionSettings(sessionSettingsForProject(project));
  }, [lastProjectId, projectId, sessionProjects]);
  
  useEffect(() => {
    const isSwitching = lastSelectedIdRef.current !== selectedId;
    lastSelectedIdRef.current = selectedId;
    loadSelected(isSwitching, { refreshTranscript: true });
  }, [selectedId, loadSelected]);

  useEffect(() => { loadModels(sessionSettings.provider, providerRuntimeStatus); }, [loadModels, providerRuntimeStatus, sessionSettings.provider]);
  useEffect(() => {
    let alive = true;
    Promise.allSettled([systemApi.getSystemStatus(), systemApi.getProviders()]).then(([status, catalog]) => {
      if (!alive) return;
      setProviderRuntimeStatus(status.status === 'fulfilled' ? status.value : { providers: [] });
      setProviderCatalog(catalog.status === 'fulfilled' && Array.isArray(catalog.value) ? catalog.value : []);
    });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    setMessageSettings(messageSettingsForRuntimeKey(selectedSessionRuntimeKey, selectedSessionProject));
  }, [selectedId, selectedSessionProject, selectedSessionRuntimeKey]);

  const scheduleListRefresh = useCallback(() => {
    if (!showSidebar) return;
    window.clearTimeout(listRefreshTimer.current);
    listRefreshTimer.current = window.setTimeout(() => loadFirstPage({
      silent: true,
      preserveLoaded: true,
      reportErrors: false,
    }), SESSION_LIST_REFRESH_DELAY_MS);
  }, [loadFirstPage, showSidebar]);

  const scheduleSelectedRefresh = useCallback((provider, threadId) => {
    const eventKey = providerSessionKey(provider, threadId);
    if (!threadId || eventKey !== selectedId) return;
    window.clearTimeout(detailRefreshTimer.current);
    detailRefreshTimer.current = window.setTimeout(
      () => loadSelected(false, { refreshTranscript: true }),
      SESSION_DETAIL_REFRESH_DELAY_MS,
    );
  }, [loadSelected, selectedId]);

  const refreshSelectedApprovals = useCallback(() => {
    if (selectedIdRef.current) loadSelected(false);
  }, [loadSelected]);

  useEffect(() => eventsApi.subscribeToEvents((event) => {
    const eventKey = eventSessionKey(event);
    if (isSessionFileEvent(event)) {
      scheduleListRefresh();
      scheduleSelectedRefresh(event.provider, event.threadId);
      return;
    }
    if (!isAgentEvent(event)) return;
    if (event.method === 'approval/requested') {
      const request = parseApprovalPayload(event.payload);
      const requestSessionKey = eventKey || eventSessionKeyFromPayload(request) || selectedIdRef.current;
      setApprovalQueue((current) => enqueueApprovalNotice(current, { request, sessionId: requestSessionKey }));
      if (requestSessionKey && requestSessionKey !== selectedIdRef.current) {
        toast.info('Provider 正在等待审批，切回对应 session 后可处理。');
      }
    }
    if (event.method === 'approval/resolved') {
      setApprovalQueue((current) => removeApprovalRequest(current, parseApprovalResolvedPayload(event.payload)));
    }
    if (event.threadId && isSessionStartEvent(event)) {
      setSessions((prev) => upsertRunningSessionFromEvent(prev, event, projects));
      scheduleListRefresh();
    }
    if (event.threadId && isSessionStopEvent(event)) {
      setSessions((prev) => setSessionRunningInList(prev, eventKey, false));
      setApprovalQueue((current) => removeApprovalsForSession(current, eventKey));
      if (isInterruptPendingForSession(interruptStateRef.current, eventKey)) {
        const notice = interruptCompletionNotice(eventKey, event);
        applyInterruptNotice(notice);
        showToastNotice(notice);
      }
    }
    if (eventKey !== selectedId) return;
    if (isSessionStartEvent(event)) {
      setLiveEvents([event]);
      setSessionRunning(true);
      return;
    }
    setLiveEvents((prev) => [...prev, event].slice(-200));
    if (isSessionStopEvent(event)) {
      const stoppedSessionId = eventKey;
      setSessionRunning(false);
      loadSelected(false, { refreshTranscript: true }).then(() => {
        if (selectedIdRef.current === stoppedSessionId) setLiveEvents([]);
      });
      if (showSidebar) loadFirstPage();
    }
  }, undefined, refreshSelectedApprovals), [
    loadFirstPage,
    loadSelected,
    refreshSelectedApprovals,
    scheduleListRefresh,
    scheduleSelectedRefresh,
    selectedId,
    applyInterruptNotice,
    projects,
    showSidebar,
  ]);

  useEffect(() => () => {
    window.clearTimeout(detailRefreshTimer.current);
    window.clearTimeout(listRefreshTimer.current);
  }, []);

  const handleProjectChange = (id) => {
    const project = sessionProjects.find((item) => item.id === id) || null;
    setProjectId(id);
    setCwd(project?.cwd || cwd);
    setSessionSettings((current) => sessionSettingsForProject(
      project,
      current,
      providerSelectionTouchedRef.current,
    ));
  };

  const handleReorderProjects = useCallback(async (sourceId, targetId) => {
    const nextProjects = orderedProjectsAfterMove(projects, sourceId, targetId);
    if (nextProjects === projects) return;

    setSavingProjectOrder(true);
    setProjects(nextProjects);
    try {
      const updated = await projectsApi.reorderProjects(nextProjects.map((project) => project.id));
      setProjects(updated || nextProjects);
    } catch (err) {
      setProjects(projects);
      toast.error(err.message || '保存项目顺序失败');
    } finally {
      setSavingProjectOrder(false);
    }
  }, [projects, setProjects]);

  const handleSettingChange = (field, value) => {
    if (field === 'provider') providerSelectionTouchedRef.current = true;
    setSessionSettings((current) => field === 'provider'
      ? sessionSettingsForProvider(current, value)
      : { ...current, [field]: value });
  };

  const handleMessageSettingChange = (field, value) => {
    setMessageSettings((current) => ({ ...current, [field]: value }));
  };

  const resolveApproval = async (decision, scope = 'turn') => {
    if (!approvalRequest) return;
    setApprovalSubmitting(true);
    try {
      await runsApi.resolveCodexApproval(approvalRequest.id, { decision, scope });
      setApprovalQueue((current) => removeApprovalRequest(current, approvalRequest));
    } catch (err) {
      toast.error(err.message || '提交授权决策失败');
    } finally {
      setApprovalSubmitting(false);
    }
  };

  const addOptimisticUserMessage = useCallback((sessionId, promptText, id = queuedMessageId()) => {
    const message = createOptimisticSessionUserMessage({
      id,
      sessionId,
      prompt: promptText,
      session: selectedSession?.id === sessionId ? selectedSession : null,
    });
    if (!message) return null;
    setOptimisticUserMessages((current) => [...current, message]);
    return message;
  }, [selectedSession]);

  const removeOptimisticUserMessage = useCallback((id) => {
    if (!id) return;
    setOptimisticUserMessages((current) => current.filter((message) => message.id !== id));
  }, []);

  useEffect(() => {
    setOptimisticUserMessages((current) => reconcileOptimisticSessionUserMessages(current, selectedSession));
  }, [selectedSession]);

  const startSessionMessage = useCallback(async (sessionId, promptText, settings, references = []) => {
    const optimisticMessage = addOptimisticUserMessage(sessionId, promptText);
    try {
      const result = await runsApi.sendSessionMessage(sessionId, sessionPayloadWithReferences(promptText, {
        model: availableProviderModelValue(settings.model, models),
        reasoning_effort: settings.reasoningEffort,
        service_tier: settings.serviceTier,
        approval_policy: settings.approvalPolicy,
        sandbox: settings.sandbox,
        execution_policy: settings.executionPolicy,
      }, references));
      const running = isSessionRunning(result);
      setSessionRunning(running);
      setSessions((prev) => setSessionRunningInList(prev, sessionId, running));
      setLiveEvents([]);
      if (!running) await loadSelected(false);
    } catch (err) {
      removeOptimisticUserMessage(optimisticMessage?.id);
      throw err;
    }
  }, [addOptimisticUserMessage, loadSelected, models, removeOptimisticUserMessage]);

  const steerSessionMessage = useCallback(async (sessionId, promptText, settings, references = []) => {
    await runsApi.steerSessionMessage(sessionId, sessionPayloadWithReferences(promptText, {
      model: availableProviderModelValue(settings.model, models),
      reasoning_effort: settings.reasoningEffort,
      service_tier: settings.serviceTier,
      approval_policy: settings.approvalPolicy,
      sandbox: settings.sandbox,
      execution_policy: settings.executionPolicy,
    }, references));
  }, [models]);

  const sendQueuedMessage = useCallback(async (sessionId) => {
    const queued = nextPendingQueuedSessionMessage(messageQueueRef.current, sessionId);
    if (!queued || activeQueuedSendsRef.current.has(queued.id)) return;
    activeQueuedSendsRef.current.add(queued.id);
    setSending(true);
    setMessageQueue((current) => markQueuedSessionMessageSending(current, queued.id));
    try {
      await startSessionMessage(sessionId, queued.prompt, queued.settings, queued.references);
      setMessageQueue((current) => removeQueuedSessionMessage(current, queued.id));
    } catch (err) {
      setMessageQueue((current) => markQueuedSessionMessageFailed(current, queued.id, err.message || '发送排队消息失败'));
      toast.error(err.message || '发送排队消息失败');
    } finally {
      activeQueuedSendsRef.current.delete(queued.id);
      setSending(false);
    }
  }, [startSessionMessage]);

  useEffect(() => {
    if (!selectedId || !selectedDetailReady || sessionRunning || sending) return;
    if (isInterruptPendingForSession(interruptStateRef.current, selectedId)) return;
    sendQueuedMessage(selectedId);
  }, [selectedId, selectedDetailReady, sessionRunning, sending, messageQueue, sendQueuedMessage]);

  const sendMessage = async (event) => {
    event.preventDefault();
    const promptText = message.trim();
    const referencesSnapshot = messageReferences;
    const wantsOppositeMode = Boolean(event.metaKey || event.ctrlKey);
    const canSteer = String(selectedSession?.provider || selectedId.split(':')[0] || 'codex') === 'codex';
    const shouldGuide = canSteer && sessionRunning && (wantsOppositeMode ? !followRunningTurn : followRunningTurn);
    if (!selectedId || sending || isInterruptPendingForSession(interruptStateRef.current, selectedId)) return;
    if (!hasComposerContent(promptText, messageReferences)) return;
    if (messageReferenceValidation.hasErrors) {
      toast.error(messageReferenceValidation.message);
      return;
    }
    if (messageCommand) {
      toast.error('Command 请使用 command 面板执行，不会作为普通 prompt 发送。');
      return;
    }
    if (shouldGuide) {
      const optimisticMessage = addOptimisticUserMessage(selectedId, promptText);
      setSending(true);
      clearMessageDraft();
      try {
        await steerSessionMessage(selectedId, promptText, messageSettings, messageReferences);
        toast.info('已引导当前响应。');
      } catch (err) {
        removeOptimisticUserMessage(optimisticMessage?.id);
        restoreMessageDraft(promptText, referencesSnapshot);
        toast.error(err.message || '引导当前响应失败');
      } finally {
        setSending(false);
      }
      return;
    }
    if (sessionRunning || currentQueuedMessages.length > 0) {
      const queued = createQueuedSessionMessage({
        id: queuedMessageId(),
        sessionId: selectedId,
        prompt: promptText,
        references: messageReferences,
        settings: messageSettings,
      });
      setMessageQueue((current) => enqueueQueuedSessionMessage(current, queued));
      clearMessageDraft();
      toast.info(sessionRunning ? '已排队为下一条消息。' : '已追加到消息队列。');
      return;
    }
    setSending(true);
    clearMessageDraft();
    try {
      await startSessionMessage(selectedId, promptText, messageSettings, messageReferences);
      setMessageCommand(clearSessionCommandState());
    } catch (err) {
      restoreMessageDraft(promptText, referencesSnapshot);
      toast.error(err.message || '发送消息失败');
    } finally {
      setSending(false);
    }
  };

  const clearMessageDraft = () => {
    setMessage('');
    setMessageReferences([]);
  };

  const restoreMessageDraft = (promptText, references = []) => {
    setMessage((current) => current.trim() ? current : promptText);
    setMessageReferences((current) => current.length > 0 ? current : references);
  };


  const executeNewSessionCommand = async () => {
    await executeSessionCommand({
      commandState: promptCommand,
      context: newCommandContext,
      setResult: setPromptCommandResult,
      setError: setPromptCommandError,
      afterSuccess: async () => {
        await refreshData(['workSummary']);
        setPrompt('');
        setPromptReferences([]);
      },
    });
  };

  const executeMessageCommand = async () => {
    await executeSessionCommand({
      commandState: messageCommand,
      context: messageCommandContext,
      setResult: setMessageCommandResult,
      setError: setMessageCommandError,
      afterSuccess: async () => {
        await refreshData(['workSummary']);
        setMessage('');
        setMessageReferences([]);
      },
    });
  };

  const executeSessionCommand = async ({ commandState, context, setResult, setError, afterSuccess }) => {
    if (!commandState || commandExecuting) return;
    const validation = validateSessionCommand(commandState, context);
    if (validation) {
      setError(validation);
      return;
    }
    setCommandExecuting(true);
    setError('');
    try {
      const result = await systemApi.executeCommand(buildRunnerCommandRequest(commandState, context, { confirmed: true }));
      setResult(result);
      if (context.sessionId) {
        await loadSelected(false);
      }
      await afterSuccess?.(result);
    } catch (err) {
      setError(err.message || 'Command 执行失败');
    } finally {
      setCommandExecuting(false);
    }
  };

  const interrupt = async () => {
    if (!selectedId || isInterruptPendingForSession(interruptStateRef.current, selectedId)) return;
    const requestId = selectedId;
    applyInterruptNotice({
      sessionId: requestId,
      status: 'pending',
      tone: 'info',
      text: '正在发送中断请求...',
    });
    try {
      const result = await runsApi.interruptSession(requestId);
      const notice = interruptRequestNotice(requestId, result);
      if (isInterruptPendingForSession(interruptStateRef.current, requestId)) {
        applyInterruptNotice(notice);
        showToastNotice(notice);
      }
      if (!result?.interrupted) {
        setSessionRunning(false);
        setSessions((prev) => setSessionRunningInList(prev, requestId, false));
      }
    } catch (err) {
      const notice = interruptFailureNotice(requestId, err);
      if (isInterruptPendingForSession(interruptStateRef.current, requestId)) {
        applyInterruptNotice(notice);
        showToastNotice(notice);
      }
    }
  };

  const cancelQueuedMessage = (id) => {
    setMessageQueue((current) => removeQueuedSessionMessage(current, id));
  };

  const retryQueuedMessage = (id) => {
    setMessageQueue((current) => retryQueuedSessionMessage(current, id));
  };

  // 新建并启动会话
  const handleCreateNewSession = async (e) => {
    if (e) e.preventDefault();
    if (sending) return;
    const selectedProviderStatus = (providerRuntimeStatus?.providers || []).find(item => item.id === sessionSettings.provider) || {
      id: sessionSettings.provider,
      ready: false,
      available: false,
      readiness_reason: 'Provider readiness status is unavailable',
    };
    const guard = canCreateSession({
      projectId,
      cwd,
      prompt,
      selectedProject,
      providerId: sessionSettings.provider,
      providerStatus: selectedProviderStatus,
      references: promptReferences,
    });
    if (!guard.ok) {
      if (guard.reason === 'missing_project' || guard.reason === 'unsupported_provider' || guard.reason === 'provider_not_ready') {
        toast.error(guard.message || PROJECT_REQUIRED_MESSAGE);
      }
      return;
    }
    if (newSessionReferenceValidation.hasErrors) {
      toast.error(newSessionReferenceValidation.message);
      return;
    }
    setSending(true);
    try {
      const result = await runsApi.createSession(sessionPayloadWithReferences(prompt.trim(), {
        project_id: projectId,
        provider: sessionSettings.provider,
        cwd,
        model: availableProviderModelValue(sessionSettings.model, models),
        reasoning_effort: sessionSettings.reasoningEffort,
        service_tier: sessionSettings.serviceTier,
        approval_policy: sessionSettings.approvalPolicy,
        sandbox: sessionSettings.sandbox,
        execution_policy: sessionSettings.executionPolicy,
      }, promptReferences));
      const newSessionId = sessionIDFromCreateResult(result);
      const createdSession = sessionFromCreateResult(result, selectedProject);
      if (!newSessionId || !createdSession) throw new Error('Provider session 创建成功，但响应缺少有效 session ref');
      addOptimisticUserMessage(newSessionId, prompt.trim());
      setSelectedId(newSessionId);
      setSessionRunning(Boolean(result.turn_id || result.provider_turn_id));
      setSessions((prev) => mergeRefreshedSessions(prev, [{
        ...createdSession,
        preview: prompt.trim().replace(/\s+/g, ' ').slice(0, 120),
      }]));
      setLiveEvents([]);
      setPrompt('');
      setPromptReferences([]);
      setPromptCommand(clearSessionCommandState());
      await loadFirstPage({ preserveLoaded: true });
      if (keepNewSessionRoute) navigateTo?.('runs', null, '', '', { sessionId: newSessionId });
    } catch (err) {
      toast.error(err.message || '创建 session 失败');
    } finally {
      setSending(false);
    }
  };

  const selectSession = useCallback((id) => {
    const nextSession = sessions.find((item) => item.id === id);
    ignorePropSelectionRef.current = false;
    setSelectedId(id);
    setDetailError('');
    setActiveView('chat');
    setLiveEvents([]);
    setSessionRunning(isSessionRunning(nextSession));
    if (keepNewSessionRoute) navigateTo?.('runs', null, '', '', { sessionId: id });
  }, [keepNewSessionRoute, navigateTo, sessions]);

  const openNewSession = useCallback(() => {
    ignorePropSelectionRef.current = true;
    autoSelectFirstSessionRef.current = false;
    if (!keepNewSessionRoute) navigateTo?.('sessions');
    setSelectedId('');
    setDetailError('');
    setActiveView('new');
    setPrompt('');
    setPromptCommand(clearSessionCommandState());
    setPromptCommandResult(null);
    setPromptCommandError('');
    setSessionRunning(false);
  }, [keepNewSessionRoute, navigateTo]);

  return (
    <>
      {showSidebar ? (
        <SessionSidebar
          activeView={activeView}
          cursor={cursor}
          loading={loading && sessions.length === 0}
          loadingMore={loadingMore}
          projects={projects}
          savingProjectOrder={savingProjectOrder}
          selectedId={selectedId}
          sessions={sessions}
          onLoadMore={loadMore}
          onNewSession={openNewSession}
          onReorderProjects={handleReorderProjects}
          onSelectSession={selectSession}
        />
      ) : null}
      <SessionWorkspace
        loading={loading && sessions.length === 0}
        activeView={activeView}
        chatProps={{
          detailLoading,
          detailError,
          hasOlderTurns: Boolean(turnCursor),
          loadOlderTurns,
          selectedSession,
          turnsLoading,
          selectedSessionProject,
          liveEvents,
          sessionRunning,
          optimisticUserMessages,
          pendingApproval: hasApprovalForSession(approvalQueue, selectedId),
          observationNotice,
          showEvidence,
          navigateTo,
          approvalRequest,
          approvalSubmitting,
          currentApprovals,
          resolveApproval,
          message,
          setMessage,
          messageSettings,
          handleMessageSettingChange,
          models,
          modelsLoading,
          modelsError,
          providerCatalog,
          sending,
          interruptState,
          selectedId,
          currentQueuedMessages,
          followRunningTurn,
          setFollowRunningTurn,
          sessionComposerSuggestions,
          messageReferenceDetails,
          setMessageReferences,
          messageReferenceValidation,
          messageCommand,
          messageCommandContext,
          commandExecuting,
          messageCommandResult,
          messageCommandError,
          setMessageCommand,
          setMessageCommandResult,
          setMessageCommandError,
          executeMessageCommand,
          sendMessage,
          interrupt,
          cancelQueuedMessage,
          retryQueuedMessage,
        }}
        newSessionProps={{
          selectedProject,
          prompt,
          setPrompt,
          promptCommand,
          newCommandContext,
          commandExecuting,
          promptCommandResult,
          promptCommandError,
          executeNewSessionCommand,
          setPromptCommand,
          setPromptCommandError,
          setPromptCommandResult,
          sessionComposerSuggestions,
          newSessionReferenceDetails,
          promptReferences,
          setPromptReferences,
          sending,
          newSessionReferenceValidation,
          handleCreateNewSession,
          sessionSettings,
          handleSettingChange,
          models,
          modelsError,
          modelsLoading,
          projectId,
          handleProjectChange,
          sessionProjects,
          providerOptions: readySessionProviders(providerRuntimeStatus),
          providerCatalog,
        }}
      />
    </>
  );
}

function showToastNotice(notice) {
  if (!notice?.text) return;
  const tone = notice.tone || 'info';
  if (tone === 'success') {
    toast.success(notice.text);
  } else if (tone === 'error') {
    toast.error(notice.text);
  } else if (tone === 'warning') {
    toast.warning(notice.text);
  } else {
    toast.info(notice.text);
  }
}
