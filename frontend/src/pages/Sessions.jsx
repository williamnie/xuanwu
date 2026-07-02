import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { 
  ChevronDown, ChevronRight, ExternalLink, FileCode, Info, Loader2, Plus, Settings,
  Pin, MessageSquarePlus,
  SlidersHorizontal, ShieldAlert, Brain, ArrowUp, Folder, Gauge
} from 'lucide-react';
import { api } from '../api/client';
import { message as toast } from '../store/toastStore';
import MarkdownPreview from '../components/editor/MarkdownPreview';
import PromptEditor from '../components/editor/PromptEditor';
import { selectProjects, selectRefreshData, selectSetProjects, useDataStore } from '../store/dataStore';
import ApprovalDialog from './sessions/ApprovalDialog';
import {
  approvalsForSession,
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
  normalizeQueuedSessionMessages,
  removeQueuedSessionMessage,
  retryQueuedSessionMessage,
} from './sessions/sessionMessageQueue';
import { PROJECT_REQUIRED_MESSAGE, canCreateSession, resolveLastSessionProject } from './sessions/newSessionGuards';
import SessionComposer from './sessions/SessionComposer';
import SessionCommandPanel from './sessions/SessionCommandPanel';
import { buildRunnerCommandRequest, clearSessionCommandState, createSessionCommandState, validateSessionCommand } from './sessions/sessionCommands';
import SessionCommandReplay from './sessions/SessionCommandReplay.js';
import './sessions/SessionCommandReplay.css';
import {
  defaultMessageSettings,
  defaultSessionSettings,
  modelLabel,
  providerSupports,
  providerLabel as projectProviderLabel,
  serviceTierOptions,
} from './sessions/sessionOptions';
import VirtualSessionList from './sessions/VirtualSessionList';
import { SESSION_LIST_FILTER_ALL, SESSION_LIST_FILTER_RECENT, SESSION_LIST_FILTER_RUNNING } from './sessions/sessionListFilters';
import { orderedProjectsAfterMove } from './sessions/projectOrder';
import { useSmartAutoScroll } from './sessions/smartAutoScroll';
import {
  isRenderableToolItem,
  parseLiveSessionEvents,
  shouldRenderLiveTurn,
  toolDisplayForItem,
} from './sessions/sessionTranscriptItems';
import { buildSessionComposerSuggestions } from './sessions/sessionComposerAssist';
import { messageSettingsForRuntimeKey, sessionRuntimeSettingsKey } from './sessions/sessionRuntimeSettings';
import {
  addSessionReference,
  buildReferenceDetails,
  hasComposerContent,
  referenceValidation,
  removeSessionReference,
  sessionPayloadWithReferences,
} from './sessions/sessionReferences';
import { buildSessionIssuePayload, textFromUserContent } from './sessions/sourceIssue';
import { buildSessionResumeCommand, markdownFilenameForSession, sessionToMarkdown } from './sessions/sessionMarkdownExport.js';
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
import './sessions/Sessions.css';
import './sessions/SessionsClient.css';

const PAGE_SIZE = 50;
const SESSION_DETAIL_REFRESH_DELAY_MS = 250;
const SESSION_DETAIL_RECONCILE_INTERVAL_MS = 30_000;
const SESSION_LIST_RECONCILE_INTERVAL_MS = 30_000;
const SESSION_LIST_REFRESH_DELAY_MS = 800;
const DEFAULT_SESSION_PROVIDER = 'codex';
const EMPTY_CAPABILITIES = { skills: [], plugins: [] };
const SESSION_APP_SIDEBAR_SLOT_ID = 'sessions-app-sidebar-slot';
const MESSAGE_QUEUE_STORAGE_KEY = 'codex-session-message-queue';

function readQueuedSessionMessages() {
  try {
    return normalizeQueuedSessionMessages(JSON.parse(window.localStorage.getItem(MESSAGE_QUEUE_STORAGE_KEY) || '[]'));
  } catch {
    return [];
  }
}

function persistQueuedSessionMessages(queue) {
  try {
    const active = normalizeQueuedSessionMessages(queue);
    window.localStorage.setItem(MESSAGE_QUEUE_STORAGE_KEY, JSON.stringify(active));
  } catch {
    // localStorage 不可用时仅保留当前页面内队列。
  }
}

function queuedMessageId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function compactModelName(value) {
  return String(value || '')
    .replace(/^gpt[-\s]*/i, '')
    .replace(/^GPT[-\s]*/i, '')
    .replace(/-/g, ' ')
    .trim();
}

function effectiveModelForSettings(settings, models) {
  return models.find((model) => model.id === settings.model || model.model === settings.model)
    || models.find((model) => model.isDefault)
    || models[0]
    || null;
}

function serviceTierLabel(settings, models) {
  const options = serviceTierOptions(effectiveModelForSettings(settings, models), settings.serviceTier);
  const option = options.find((item) => item.value === (settings.serviceTier || ''));
  return option?.shortLabel || option?.label || '标准';
}

function NewSessionPermissionControl({ settings, onSettingChange }) {
  return (
    <div className="composer-embedded-select danger">
      <ShieldAlert size={13} />
      <span>{permissionPresetLabel(settings)}</span>
      <select
        value={`${settings.sandbox}|${settings.approvalPolicy}`}
        onChange={(e) => {
          const [sandbox, approvalPolicy] = e.target.value.split('|');
          onSettingChange('sandbox', sandbox);
          onSettingChange('approvalPolicy', approvalPolicy);
        }}
      >
        <option value="danger-full-access|never">完全访问权限</option>
        <option value="workspace-write|never">工作区写入</option>
        <option value="workspace-write|danger-only">按需授权</option>
        <option value="workspace-write|always">每次授权</option>
        <option value="read-only|always">只读模式</option>
      </select>
    </div>
  );
}

function permissionPresetLabel(settings) {
  switch (`${settings.sandbox}|${settings.approvalPolicy}`) {
    case 'danger-full-access|never': return '完全访问权限';
    case 'workspace-write|never': return '工作区写入';
    case 'workspace-write|danger-only': return '按需授权';
    case 'workspace-write|always': return '每次授权';
    case 'read-only|always': return '只读模式';
    default: return '自定义权限';
  }
}

function NewSessionComposerActions({ settings, models, sending, canSubmit, onModelChange, onServiceTierChange, onSubmit }) {
  const tierOptions = serviceTierOptions(effectiveModelForSettings(settings, models), settings.serviceTier);
  return (
    <>
      <div className="composer-embedded-select">
        <Brain size={13} />
        <span>{settings.model ? compactModelName(settings.model) : '5.5 超高'}</span>
        <select value={settings.model} onChange={(e) => onModelChange(e.target.value)}>
          <option value="">Codex 默认</option>
          {models.map((model) => (
            <option key={model.id || model.model} value={model.id || model.model}>
              {compactModelName(modelLabel(model))}
            </option>
          ))}
        </select>
      </div>
      <div className="composer-embedded-select">
        <Gauge size={13} />
        <span>{serviceTierLabel(settings, models)}</span>
        <select value={settings.serviceTier || ''} onChange={(e) => onServiceTierChange(e.target.value)}>
          {tierOptions.map((tier) => (
            <option key={tier.value || 'standard'} value={tier.value}>{tier.shortLabel || tier.label}</option>
          ))}
        </select>
      </div>
      <button
        type="button"
        className="composer-circle-submit"
        disabled={sending || !canSubmit}
        onClick={onSubmit}
        title="发送并新建会话"
      >
        {sending ? <Loader2 className="animate-spin" size={16} /> : <ArrowUp size={16} strokeWidth={2.4} />}
      </button>
    </>
  );
}

export default function Sessions({ selectedSessionId = '', navigateTo }) {
  const projects = useDataStore(selectProjects);
  const refreshData = useDataStore(selectRefreshData);
  const setProjects = useDataStore(selectSetProjects);
  const [sessions, setSessions] = useState([]);
  const [cursor, setCursor] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [selectedSession, setSelectedSession] = useState(null);
  const [loading, setLoading] = useState(true);
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
  const [pathReferences, setPathReferences] = useState({ files: [], folders: [] });
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
  const autoSelectFirstSessionRef = useRef(true);
  const interruptStateRef = useRef(interruptState);
  const messageQueueRef = useRef(messageQueue);
  const activeQueuedSendsRef = useRef(new Set());
  const [sidebarPortalTarget, setSidebarPortalTarget] = useState(null);

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

  // 客户端风格路由与置顶状态
  const [activeView, setActiveView] = useState('chat');
  const [sessionListFilter, setSessionListFilter] = useState(SESSION_LIST_FILTER_ALL);
  const [pinnedSessionIds, setPinnedSessionIds] = useState(() => {
    const stored = localStorage.getItem('codex-pinned-sessions');
    return stored ? JSON.parse(stored) : [];
  });

  const togglePinSession = (id, event) => {
    if (event) event.stopPropagation();
    setPinnedSessionIds((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      localStorage.setItem('codex-pinned-sessions', JSON.stringify(next));
      return next;
    });
  };

  useEffect(() => {
    setSidebarPortalTarget(document.getElementById(SESSION_APP_SIDEBAR_SLOT_ID));
  }, []);

  useEffect(() => {
    if (selectedId) {
      setActiveView('chat');
    } else {
      setActiveView('new');
    }
  }, [selectedId]);

  const sessionProjects = useMemo(
    () => projects.filter((project) => providerSupports(project, 'sessions')),
    [projects],
  );
  const selectedProject = sessionProjects.find((project) => project.id === projectId);
  const selectedSessionProject = useMemo(() => {
    const sessionCwd = selectedSession?.cwd || selectedSession?.path || '';
    return projects.find((project) => project.cwd === sessionCwd) || null;
  }, [projects, selectedSession]);
  const referenceIssues = useMemo(() => [], []);
  const sessionComposerSuggestions = useMemo(() => buildSessionComposerSuggestions({
    projects,
    issues: referenceIssues,
    currentProject: selectedSessionProject,
    linkedIssues: selectedSession?.source_issues || [],
    capabilities: EMPTY_CAPABILITIES,
    pathReferences,
  }), [pathReferences, projects, referenceIssues, selectedSession?.source_issues, selectedSessionProject]);
  const newSessionReferenceDetails = useMemo(() => buildReferenceDetails(promptReferences, {
    issues: referenceIssues, projects, currentProjectId: projectId,
  }), [projectId, projects, promptReferences, referenceIssues]);
  const messageReferenceDetails = useMemo(() => buildReferenceDetails(messageReferences, {
    issues: referenceIssues, projects, currentProjectId: selectedSessionProject?.id || '',
  }), [messageReferences, projects, referenceIssues, selectedSessionProject?.id]);
  const newSessionReferenceValidation = useMemo(
    () => referenceValidation(newSessionReferenceDetails),
    [newSessionReferenceDetails],
  );
  const messageReferenceValidation = useMemo(
    () => referenceValidation(messageReferenceDetails),
    [messageReferenceDetails],
  );
  const newCommandContext = useMemo(() => ({
    prompt, references: promptReferences, projectId, sessionId: '', linkedIssues: [],
  }), [projectId, prompt, promptReferences]);
  const messageCommandContext = useMemo(() => ({
    prompt: message, references: messageReferences, projectId: selectedSessionProject?.id || '',
    sessionId: selectedId, linkedIssues: selectedSession?.source_issues || [],
  }), [message, messageReferences, selectedId, selectedSession?.source_issues, selectedSessionProject?.id]);
  const selectedSessionRuntimeKey = sessionRuntimeSettingsKey(selectedSession);
  const pathSearchRequest = useMemo(() => (
    pathReferenceSearchFromText(prompt, projectId) ||
    pathReferenceSearchFromText(message, selectedSessionProject?.id || '')
  ), [message, projectId, prompt, selectedSessionProject?.id]);

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
      const result = await api.getSessions({ limit: PAGE_SIZE });
      const data = result.data || [];
      const nextCursor = result.nextCursor || '';
      setSessions((current) => (
        preserveLoaded && nextCursor ? mergeRefreshedSessions(current, data) : data
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
      const result = await api.getSessions({ limit: PAGE_SIZE, cursor });
      setSessions((prev) => mergeSessions(prev, result.data || []));
      setCursor(result.nextCursor || '');
    } catch (err) {
      toast.error(err.message || '继续加载 sessions 失败');
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore]);

  const loadSelected = useCallback(async (isSwitching = false) => {
    if (!selectedId) return;
    if (isSwitching) {
      setDetailLoading(true);
      setSelectedSession(null);
    }
    const requestId = selectedId;
    try {
      const detail = await api.getSession(requestId);
      if (selectedIdRef.current !== requestId) return;
      const running = isSessionRunning(detail);
      setSelectedSession(detail);
      setSessionRunning(running);
      setSessions((prev) => syncSessionRuntimeInList(prev, detail, running));
      setApprovalQueue((current) => syncApprovalsForSession(
        current,
        requestId,
        normalizePendingApprovals(detail.pending_approvals),
      ));
    } catch (err) {
      if (selectedIdRef.current !== requestId) return;
      toast.error(err.message || '读取 session 详情失败');
    } finally {
      if (selectedIdRef.current === requestId) {
        setDetailLoading(false);
      }
    }
  }, [selectedId]);

  const loadModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const result = await api.getCodexModels();
      setModels(result.data || []);
      setModelsError('');
    } catch (err) {
      setModelsError(err.message || '读取 Codex 模型列表失败');
    } finally {
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!pathSearchRequest) {
      setPathReferences({ files: [], folders: [] });
      return undefined;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      api.searchProjectReferences(pathSearchRequest.projectId, {
        type: pathSearchRequest.type, query: pathSearchRequest.query, limit: 40,
      }).then((result) => {
        if (alive) setPathReferences({ files: result?.files || [], folders: result?.folders || [] });
      }).catch(() => {
        if (alive) setPathReferences({ files: [], folders: [] });
      });
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [pathSearchRequest]);

  useEffect(() => { loadFirstPage(); }, [loadFirstPage]);
  useEffect(() => {
    let alive = true;
    api.getSessionPreferences()
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
    setSessionSettings(defaultSessionSettings(project));
  }, [lastProjectId, projectId, sessionProjects]);
  
  useEffect(() => {
    const isSwitching = lastSelectedIdRef.current !== selectedId;
    lastSelectedIdRef.current = selectedId;
    loadSelected(isSwitching);
  }, [selectedId, loadSelected]);

  useEffect(() => {
    if (!selectedId) return undefined;
    const interval = window.setInterval(() => loadSelected(false), SESSION_DETAIL_RECONCILE_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [loadSelected, selectedId]);

  useEffect(() => {
    const interval = window.setInterval(() => loadFirstPage({
      silent: true,
      preserveLoaded: true,
      reportErrors: false,
    }), SESSION_LIST_RECONCILE_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [loadFirstPage]);

  useEffect(() => { loadModels(); }, [loadModels]);
  useEffect(() => {
    setMessageSettings(messageSettingsForRuntimeKey(selectedSessionRuntimeKey, selectedSessionProject));
  }, [selectedId, selectedSessionProject, selectedSessionRuntimeKey]);

  const scheduleListRefresh = useCallback(() => {
    window.clearTimeout(listRefreshTimer.current);
    listRefreshTimer.current = window.setTimeout(() => loadFirstPage({
      silent: true,
      preserveLoaded: true,
      reportErrors: false,
    }), SESSION_LIST_REFRESH_DELAY_MS);
  }, [loadFirstPage]);

  const scheduleSelectedRefresh = useCallback((threadId) => {
    const eventKey = providerSessionKey(DEFAULT_SESSION_PROVIDER, threadId);
    if (!threadId || eventKey !== selectedId) return;
    window.clearTimeout(detailRefreshTimer.current);
    detailRefreshTimer.current = window.setTimeout(loadSelected, SESSION_DETAIL_REFRESH_DELAY_MS);
  }, [loadSelected, selectedId]);

  const refreshSelectedApprovals = useCallback(() => {
    if (selectedIdRef.current) loadSelected(false);
  }, [loadSelected]);

  useEffect(() => api.subscribeToEvents((event) => {
    const eventKey = eventSessionKey(event);
    if (isSessionFileEvent(event)) {
      scheduleListRefresh();
      scheduleSelectedRefresh(event.threadId);
      return;
    }
    if (!isAgentEvent(event)) return;
    if (event.method === 'approval/requested') {
      const request = parseApprovalPayload(event.payload);
      const requestSessionKey = eventKey || eventSessionKeyFromPayload(request) || selectedIdRef.current;
      setApprovalQueue((current) => enqueueApprovalNotice(current, { request, sessionId: requestSessionKey }));
      if (requestSessionKey && requestSessionKey !== selectedIdRef.current) {
        toast.info('Codex 正在等待审批，切回对应 session 后可处理。');
      }
    }
    if (event.method === 'approval/resolved') {
      setApprovalQueue((current) => removeApprovalRequest(current, parseApprovalResolvedPayload(event.payload)));
    }
    if (event.threadId && isSessionStartEvent(event)) {
      setSessions((prev) => setSessionRunningInList(prev, eventKey, true));
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
      loadSelected().then(() => {
        if (selectedIdRef.current === stoppedSessionId) setLiveEvents([]);
      });
      loadFirstPage();
    }
  }, undefined, refreshSelectedApprovals), [
    loadFirstPage,
    loadSelected,
    refreshSelectedApprovals,
    scheduleListRefresh,
    scheduleSelectedRefresh,
    selectedId,
    applyInterruptNotice,
  ]);

  useEffect(() => () => {
    window.clearTimeout(detailRefreshTimer.current);
    window.clearTimeout(listRefreshTimer.current);
  }, []);

  const handleProjectChange = (id) => {
    const project = sessionProjects.find((item) => item.id === id) || null;
    setProjectId(id);
    setCwd(project?.cwd || cwd);
    setSessionSettings(defaultSessionSettings(project));
  };

  const handleReorderProjects = useCallback(async (sourceId, targetId) => {
    const nextProjects = orderedProjectsAfterMove(projects, sourceId, targetId);
    if (nextProjects === projects) return;

    setSavingProjectOrder(true);
    setProjects(nextProjects);
    try {
      const updated = await api.reorderProjects(nextProjects.map((project) => project.id));
      setProjects(updated || nextProjects);
    } catch (err) {
      setProjects(projects);
      toast.error(err.message || '保存项目顺序失败');
    } finally {
      setSavingProjectOrder(false);
    }
  }, [projects, setProjects]);

  const handleSettingChange = (field, value) => {
    setSessionSettings((current) => ({ ...current, [field]: value }));
  };

  const handleMessageSettingChange = (field, value) => {
    setMessageSettings((current) => ({ ...current, [field]: value }));
  };

  const resolveApproval = async (decision, scope = 'turn') => {
    if (!approvalRequest) return;
    setApprovalSubmitting(true);
    try {
      await api.resolveCodexApproval(approvalRequest.id, { decision, scope });
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
      await api.sendSessionMessage(sessionId, sessionPayloadWithReferences(promptText, {
        model: settings.model,
        reasoning_effort: settings.reasoningEffort,
        service_tier: settings.serviceTier,
        approval_policy: settings.approvalPolicy,
        sandbox: settings.sandbox,
      }, references));
      setSessionRunning(true);
      setSessions((prev) => setSessionRunningInList(prev, sessionId, true));
      setLiveEvents([]);
    } catch (err) {
      removeOptimisticUserMessage(optimisticMessage?.id);
      throw err;
    }
  }, [addOptimisticUserMessage, removeOptimisticUserMessage]);

  const steerSessionMessage = useCallback(async (sessionId, promptText, settings, references = []) => {
    await api.steerSessionMessage(sessionId, sessionPayloadWithReferences(promptText, {
      model: settings.model,
      reasoning_effort: settings.reasoningEffort,
      service_tier: settings.serviceTier,
      approval_policy: settings.approvalPolicy,
      sandbox: settings.sandbox,
    }, references));
  }, []);

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
    const wantsOppositeMode = Boolean(event.metaKey || event.ctrlKey);
    const shouldGuide = sessionRunning && (wantsOppositeMode ? !followRunningTurn : followRunningTurn);
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
      try {
        await steerSessionMessage(selectedId, promptText, messageSettings, messageReferences);
        setMessage('');
        setMessageReferences([]);
        toast.info('已引导当前响应。');
      } catch (err) {
        removeOptimisticUserMessage(optimisticMessage?.id);
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
      setMessage('');
      setMessageReferences([]);
      toast.info(sessionRunning ? '已排队为下一条消息。' : '已追加到消息队列。');
      return;
    }
    setSending(true);
    try {
      await startSessionMessage(selectedId, promptText, messageSettings, messageReferences);
      setMessage('');
      setMessageReferences([]);
      setMessageCommand(clearSessionCommandState());
    } catch (err) {
      toast.error(err.message || '发送消息失败');
    } finally {
      setSending(false);
    }
  };


  const executeNewSessionCommand = async () => {
    await executeSessionCommand({
      commandState: promptCommand,
      context: newCommandContext,
      setResult: setPromptCommandResult,
      setError: setPromptCommandError,
      afterSuccess: async () => {
        await refreshData(['issues']);
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
        await refreshData(['issues']);
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
      const result = await api.executeCommand(buildRunnerCommandRequest(commandState, context, { confirmed: true }));
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
      const result = await api.interruptSession(requestId);
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
    const guard = canCreateSession({ projectId, cwd, prompt, selectedProject, references: promptReferences });
    if (!guard.ok) {
      if (guard.reason === 'missing_project' || guard.reason === 'unsupported_provider') {
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
      const result = await api.createSession(sessionPayloadWithReferences(prompt.trim(), {
        project_id: projectId,
        cwd,
        model: sessionSettings.model,
        reasoning_effort: sessionSettings.reasoningEffort,
        service_tier: sessionSettings.serviceTier,
        approval_policy: sessionSettings.approvalPolicy,
        sandbox: sessionSettings.sandbox,
      }, promptReferences));
      const newSessionId = sessionIDFromCreateResult(result);
      addOptimisticUserMessage(newSessionId, prompt.trim());
      setSelectedId(newSessionId);
      setSessionRunning(Boolean(result.turn_id));
      setSessions((prev) => setSessionRunningInList(prev, newSessionId, Boolean(result.turn_id)));
      setLiveEvents([]);
      setPrompt('');
      setPromptReferences([]);
      setPromptCommand(clearSessionCommandState());
      await loadFirstPage();
    } catch (err) {
      toast.error(err.message || '创建 session 失败');
    } finally {
      setSending(false);
    }
  };

  // 已置顶的会话
  const pinnedSessions = useMemo(() => {
    return sessions.filter((s) => pinnedSessionIds.includes(s.id));
  }, [sessions, pinnedSessionIds]);

  const selectSession = useCallback((id) => {
    const nextSession = sessions.find((item) => item.id === id);
    ignorePropSelectionRef.current = false;
    setSelectedId(id);
    setActiveView('chat');
    setLiveEvents([]);
    setSessionRunning(isSessionRunning(nextSession));
  }, [sessions]);

  const openNewSession = useCallback(() => {
    ignorePropSelectionRef.current = true;
    autoSelectFirstSessionRef.current = false;
    navigateTo?.('sessions');
    setSelectedId('');
    setActiveView('new');
    setPrompt('');
    setPromptCommand(clearSessionCommandState());
    setPromptCommandResult(null);
    setPromptCommandError('');
    setSessionRunning(false);
  }, [navigateTo]);

  const sidebarContent = (
    <SessionSidebarContent
      activeView={activeView}
      cursor={cursor}
      loading={loading && sessions.length === 0}
      loadingMore={loadingMore}
      pinnedSessions={pinnedSessions}
      projects={projects}
      savingProjectOrder={savingProjectOrder}
      selectedId={selectedId}
      sessionListFilter={sessionListFilter}
      sessions={sessions}
      onLoadMore={loadMore}
      onNewSession={openNewSession}
      onReorderProjects={handleReorderProjects}
      onSelectSession={selectSession}
      onSessionListFilterChange={setSessionListFilter}
      onTogglePinSession={togglePinSession}
    />
  );

  if (loading && sessions.length === 0) {
    return (
      <>
        {sidebarPortalTarget ? createPortal(sidebarContent, sidebarPortalTarget) : null}
        <LoadingState />
      </>
    );
  }

  return (
    <>
      {sidebarPortalTarget ? createPortal(sidebarContent, sidebarPortalTarget) : null}
      <div className="sessions-client-container client-animate-fade-in">
        {/* 右侧主工作区 */}
        <main className="sessions-client-main">

        {activeView === 'chat' && (
          <div className="active-session-shell">
            {/* 中间聊天区 */}
            <div className="client-chat-area">
              {detailLoading ? (
                <div className="session-detail-loading">
                  <Loader2 className="animate-spin" size={24} color="var(--primary)" />
                  <span>正在加载会话详情...</span>
                </div>
              ) : selectedSession ? (
                <SessionDetail
                  session={selectedSession}
                  project={selectedSessionProject}
                  liveEvents={liveEvents}
                  running={sessionRunning}
                  optimisticUserMessages={optimisticUserMessages}
                  pendingApproval={hasApprovalForSession(approvalQueue, selectedId)}
                  navigateTo={navigateTo}
                />
              ) : (
                <EmptyDetail />
              )}
              
              <div className="client-chat-composer-section">
                <ApprovalDialog
                  request={approvalRequest}
                  submitting={approvalSubmitting}
                  queueCount={currentApprovals.length}
                  onResolve={resolveApproval}
                />
                <SessionComposer
                  value={message}
                  onChange={setMessage}
                  settings={messageSettings}
                  onSettingChange={handleMessageSettingChange}
                  models={models}
                  modelsLoading={modelsLoading}
                  modelsError={modelsError}
                  sending={sending}
                  running={sessionRunning}
                  interruptState={interruptState}
                  selectedId={selectedId}
                  queuedMessages={currentQueuedMessages}
                  followMode={followRunningTurn}
                  onFollowModeChange={setFollowRunningTurn}
                  suggestions={sessionComposerSuggestions}
                  referenceDetails={messageReferenceDetails}
                  onAttachReference={(reference) => setMessageReferences((current) => addSessionReference(current, reference))}
                  onRemoveReference={(key) => setMessageReferences((current) => removeSessionReference(current, key))}
                  hasInvalidReferences={messageReferenceValidation.hasErrors}
                  commandState={messageCommand}
                  commandContext={messageCommandContext}
                  commandExecuting={commandExecuting}
                  commandResult={messageCommandResult}
                  commandError={messageCommandError}
                  onSelectCommand={(command) => {
                    setMessageCommand(createSessionCommandState(command));
                    setMessageCommandResult(null);
                    setMessageCommandError('');
                  }}
                  onExecuteCommand={executeMessageCommand}
                  onCancelCommand={() => {
                    setMessageCommand(clearSessionCommandState());
                    setMessageCommandError('');
                  }}
                  onSubmit={sendMessage}
                  onStop={interrupt}
                  onCancelQueuedMessage={cancelQueuedMessage}
                  onRetryQueuedMessage={retryQueuedMessage}
                />
              </div>
            </div>

          </div>
        )}

        {/* 新建会话界面 */}
        {activeView === 'new' && (
          <div className="new-session-container animate-fade-in">
            <div className="new-session-center-card">
              <h1 className="new-session-title">
                我们应该在 {selectedProject?.name || '当前工作区'} 中构建什么？
              </h1>

              <div className="new-session-composer-wrapper">
                <SessionCommandPanel
                  commandState={promptCommand}
                  context={newCommandContext}
                  executing={commandExecuting}
                  result={promptCommandResult}
                  error={promptCommandError}
                  onExecute={executeNewSessionCommand}
                  onCancel={() => {
                    setPromptCommand(clearSessionCommandState());
                    setPromptCommandError('');
                  }}
                />
                <PromptEditor
                  value={prompt}
                  onChange={setPrompt}
                  placeholder="尽管问"
                  minHeight={80}
                  variant="composer"
                  suggestions={sessionComposerSuggestions}
                  referenceDetails={newSessionReferenceDetails}
                  onAttachReference={(reference) => setPromptReferences((current) => addSessionReference(current, reference))}
                  onRemoveReference={(key) => setPromptReferences((current) => removeSessionReference(current, key))}
                  onSelectCommand={(command) => {
                    setPromptCommand(createSessionCommandState(command));
                    setPromptCommandResult(null);
                    setPromptCommandError('');
                  }}
                  onSubmitKey={!promptCommand && !sending && hasComposerContent(prompt, promptReferences) && !newSessionReferenceValidation.hasErrors ? handleCreateNewSession : null}
                  footerControls={(
                    <NewSessionPermissionControl
                      settings={sessionSettings}
                      onSettingChange={handleSettingChange}
                    />
                  )}
                  actions={(
                    <NewSessionComposerActions
                      settings={sessionSettings}
                      models={models}
                      sending={sending}
                      canSubmit={!promptCommand && hasComposerContent(prompt, promptReferences) && !newSessionReferenceValidation.hasErrors}
                      onModelChange={(value) => handleSettingChange('model', value)}
                      onServiceTierChange={(value) => handleSettingChange('serviceTier', value)}
                      onSubmit={handleCreateNewSession}
                    />
                  )}
                />
              </div>

              {/* 输入框正下方的圆角配置标签 */}
              <div className="new-session-bottom-tags">
                <div className="bottom-tag-select">
                  <Folder size={13} />
                  <span>项目: {selectedProject?.name || '未选择'}</span>
                  <select value={projectId} onChange={(e) => handleProjectChange(e.target.value)}>
                    <option value="">选择项目</option>
                    {sessionProjects.map((project) => (
                      <option key={project.id} value={project.id}>{project.name}</option>
                    ))}
                  </select>
                </div>

                <div className="bottom-tag-select">
                  <SlidersHorizontal size={13} />
                  <span>Provider: {projectProviderLabel(sessionSettings.provider)}</span>
                  <select value={sessionSettings.provider} disabled>
                    <option value={sessionSettings.provider}>{projectProviderLabel(sessionSettings.provider)}</option>
                  </select>
                </div>

                <div className="bottom-tag-select">
                  <SlidersHorizontal size={13} />
                  <span>沙箱: {sessionSettings.sandbox === 'danger-full-access' ? '完全访问模式' : '安全沙箱'}</span>
                  <select value={sessionSettings.sandbox} onChange={(e) => handleSettingChange('sandbox', e.target.value)}>
                    <option value="workspace-write">本地安全沙箱</option>
                    <option value="danger-full-access">完全访问模式</option>
                    <option value="read-only">只读沙箱模式</option>
                  </select>
                </div>
              </div>
            </div>
          </div>
        )}

        </main>
      </div>
    </>
  );
}


function SessionSidebarContent({
  activeView,
  cursor,
  loading,
  loadingMore,
  pinnedSessions,
  projects,
  savingProjectOrder,
  selectedId,
  sessionListFilter,
  sessions,
  onLoadMore,
  onNewSession,
  onReorderProjects,
  onSelectSession,
  onSessionListFilterChange,
  onTogglePinSession,
}) {
  return (
    <div className="sessions-app-sidebar-panel">
      <div className="sidebar-shortcut-items">
        <button
          className={`sidebar-shortcut-item ${activeView === 'new' ? 'active' : ''}`}
          onClick={onNewSession}
          type="button"
        >
          <span className="sidebar-shortcut-item-icon"><MessageSquarePlus size={16} /></span>
          <span>新对话</span>
        </button>
      </div>

      {pinnedSessions.length > 0 && (
        <>
          <div className="sidebar-section-title">置顶</div>
          <div className="pinned-sessions-list">
            {pinnedSessions.map((session) => (
              <button
                key={session.id}
                className={`pinned-session-row ${selectedId === session.id && activeView === 'chat' ? 'active' : ''}`}
                onClick={() => onSelectSession(session.id)}
                type="button"
              >
                <span className="pinned-title" title={session.name || session.preview}>{session.name || session.preview || '未命名 Codex 会话'}</span>
                <div className="pinned-actions">
                  <span className="session-provider-pill">{providerLabel(session.provider)}</span>
                  <button
                    className="pinned-action-btn"
                    onClick={(event) => onTogglePinSession(session.id, event)}
                    title="取消置顶"
                    type="button"
                  >
                    <Pin size={11} fill="currentColor" style={{ transform: 'rotate(45deg)', color: 'var(--primary)' }} />
                  </button>
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      <div className="sidebar-section-title">项目</div>
      <SessionListFilterTabs value={sessionListFilter} onChange={onSessionListFilterChange} />
      <div className="sidebar-scroll-area">
        {loading ? (
          <div className="session-list-loading">加载 provider sessions...</div>
        ) : (
          <VirtualSessionList
            sessions={sessions}
            projects={projects}
            selectedId={selectedId}
            hasMore={Boolean(cursor)}
            loadingMore={loadingMore}
            savingOrder={savingProjectOrder}
            autoCollapseEmptyProjects={sessionListFilter === SESSION_LIST_FILTER_ALL}
            filterMode={sessionListFilter}
            onSelect={onSelectSession}
            onLoadMore={onLoadMore}
            onReorderProjects={onReorderProjects}
          />
        )}
      </div>
    </div>
  );
}


function visibleApprovalsForSession(queue, selectedId) {
  const selected = approvalsForSession(queue, selectedId);
  if (selected.length > 0 || selectedId) return selected;
  return queue;
}

function parseApprovalPayload(payload) {
  const request = approvalPayloadObject(payload);
  return {
    id: request.id || request.params?.approvalId || request.params?.itemId || request.params?.callId || '',
    method: request.method || 'approval/requested',
    params: request.params || {},
  };
}

function approvalPayloadObject(payload) {
  if (payload && typeof payload === 'object') return payload;
  try {
    const parsed = JSON.parse(payload || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function pathReferenceSearchFromText(text, projectId) {
  if (!projectId) return null;
  const match = String(text || '').match(/(?:^|\s)@(file|folder)\s+([^\n]*)$/i);
  if (!match) return null;
  return { projectId, type: match[1].toLowerCase(), query: match[2].trim() };
}

function normalizePendingApprovals(requests) {
  if (!Array.isArray(requests)) return [];
  return requests
    .map((request) => ({
      id: request?.id || '',
      method: request?.method || 'approval/requested',
      params: request?.params || {},
    }))
    .filter((request) => request.id);
}

function parseApprovalResolvedPayload(payload) {
  try {
    const request = JSON.parse(payload || '{}');
    return { id: request.id || '' };
  } catch {
    return { id: '' };
  }
}

function eventSessionKeyFromPayload(request) {
  return providerSessionKey(DEFAULT_SESSION_PROVIDER, request?.params?.threadId || '');
}

function isSessionFileEvent(event) {
  return event?.type === 'session.created' || event?.type === 'session.updated';
}

function isAgentEvent(event) {
  return event?.type === 'agent.event' || event?.type === 'codex.event';
}

function isSessionStartEvent(event) {
  return event?.agent_event_type === 'agent.turn.started' || event?.method === 'turn/started';
}

function providerSessionKey(provider = DEFAULT_SESSION_PROVIDER, sessionId = '') {
  const normalizedProvider = String(provider || DEFAULT_SESSION_PROVIDER).trim().toLowerCase();
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId) return '';
  if (normalizedSessionId.startsWith(`${normalizedProvider}:`)) return normalizedSessionId;
  return `${normalizedProvider}:${normalizedSessionId}`;
}

function eventSessionKey(event) {
  return providerSessionKey(event?.provider || DEFAULT_SESSION_PROVIDER, event?.threadId || '');
}

function sessionIDFromCreateResult(result) {
  return result?.id ||
    providerSessionKey(result?.provider || DEFAULT_SESSION_PROVIDER, result?.provider_session_id || result?.thread_id || '');
}

function providerLabel(provider) {
  switch (String(provider || DEFAULT_SESSION_PROVIDER).toLowerCase()) {
    case 'codex':
      return 'Codex';
    case 'claude':
      return 'Claude';
    case 'opencode':
      return 'opencode';
    case 'kimicode':
      return 'kimicode';
    default:
      return provider || 'Unknown';
  }
}

function displayValue(value, fallback = '未提供') {
  const text = String(value || '').trim();
  return text || fallback;
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

async function copyTextToClipboard(text) {
  if (window.navigator?.clipboard?.writeText) {
    try {
      await window.navigator.clipboard.writeText(text);
      return;
    } catch {
      // 部分自动化/非安全上下文会拒绝 Clipboard API，继续走 textarea fallback。
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!ok) throw new Error('当前浏览器不支持复制到剪贴板');
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.URL.revokeObjectURL(url);
}

function formatTokenNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? new Intl.NumberFormat('zh-CN').format(number) : '0';
}

function tokenSummary(usage) {
  const total = usage?.total_token_usage || {};
  const last = usage?.last_token_usage || {};
  if (!usage || (!total.total_tokens && !last.total_tokens)) {
    return null;
  }
  return {
    total: formatTokenNumber(total.total_tokens),
    last: formatTokenNumber(last.total_tokens),
    input: formatTokenNumber(total.input_tokens),
    output: formatTokenNumber(total.output_tokens),
    reasoning: formatTokenNumber(total.reasoning_output_tokens),
    capturedAt: usage.captured_at || '',
  };
}

function SessionListFilterTabs({ value, onChange }) {
  const filters = [
    { value: SESSION_LIST_FILTER_ALL, label: 'All' },
    { value: SESSION_LIST_FILTER_RUNNING, label: 'Running' },
    { value: SESSION_LIST_FILTER_RECENT, label: 'Recent' },
  ];

  return (
    <div className="session-list-filter-tabs" aria-label="Session 状态筛选">
      {filters.map((filter) => (
        <button
          key={filter.value}
          type="button"
          className={`session-list-filter-tab ${value === filter.value ? 'active' : ''}`}
          onClick={() => onChange(filter.value)}
        >
          {filter.label}
        </button>
      ))}
    </div>
  );
}

function mergeSessions(prev, next) {
  const seen = new Set(prev.map((item) => item.id));
  return [...prev, ...next.filter((item) => !seen.has(item.id))];
}

function mergeRefreshedSessions(current, refreshed) {
  const refreshedIds = new Set(refreshed.map((item) => item.id));
  return [
    ...refreshed,
    ...current.filter((item) => !refreshedIds.has(item.id)),
  ];
}

function isSessionRunning(session) {
  if (!session) return false;
  if (normalizePendingApprovals(session.pending_approvals).length > 0) return true;
  if (session.isRunning) return true;
  const value = sessionStatusValue(session.status);
  return ['running', 'inprogress', 'in-progress', 'streaming', 'busy'].includes(value);
}

function sessionStatusValue(status) {
  if (!status) return '';
  let value = status;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return normalizeSessionStatusValue(value);
    }
  }
  return normalizeSessionStatusValue(value.type || value.state || value.status || '');
}

function normalizeSessionStatusValue(value) {
  return String(value || '').trim().toLowerCase().replaceAll('_', '-');
}

function setSessionRunningInList(list, id, running) {
  if (!id) return list;
  let changed = false;
  const next = list.map((session) => {
    if (session.id !== id || session.isRunning === running) return session;
    changed = true;
    return { ...session, isRunning: running };
  });
  return changed ? next : list;
}

function syncSessionRuntimeInList(list, detail, running = isSessionRunning(detail)) {
  if (!detail?.id) return list;
  let changed = false;
  const next = list.map((session) => {
    if (session.id !== detail.id) return session;
    changed = true;
    return {
      ...session,
      name: detail.name ?? session.name,
      preview: detail.preview ?? session.preview,
      status: detail.status ?? session.status,
      origin: detail.origin ?? session.origin,
      updatedAt: detail.updatedAt ?? session.updatedAt,
      pending_approvals: detail.pending_approvals || [],
      isRunning: running,
    };
  });
  return changed ? next : list;
}

function LoadingState() {
  return <div style={{ display: 'grid', placeItems: 'center', height: '60vh' }}><Loader2 className="animate-spin" size={36} color="var(--primary)" /></div>;
}

function EmptyDetail() {
  return <div className="session-empty">选择一个 provider session 查看历史，或创建新 session。</div>;
}

function parseDiff(diffText) {
  if (!diffText) return [];
  const lines = diffText.split('\n');
  const files = [];
  let currentFile = null;

  for (const line of lines) {
    if (line.startsWith('--- ') || line.startsWith('diff --git ')) {
      let fullPath;
      if (line.startsWith('--- ')) {
        fullPath = line.substring(4).trim();
      } else {
        const parts = line.split(' ');
        fullPath = parts[parts.length - 1].substring(2).trim();
      }
      if (fullPath.startsWith('a/') || fullPath.startsWith('b/')) {
        fullPath = fullPath.substring(2);
      }
      const name = fullPath.split('/').pop() || fullPath;
      currentFile = {
        path: fullPath,
        name: name,
        added: 0,
        removed: 0,
        lines: [],
      };
      files.push(currentFile);
    } else if (currentFile) {
      currentFile.lines.push(line);
      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentFile.added++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        currentFile.removed++;
      }
    }
  }
  return files;
}

function projectNameFromPath(cwd) {
  const trimmed = String(cwd || '').trim().replace(/[\\/]+$/, '');
  if (!trimmed) return 'No project';
  return trimmed.split(/[\\/]/).pop() || 'No project';
}

function fileNameFromPath(path) {
  const value = String(path || '');
  return value.split(/[\\/]/).pop() || value;
}

function filesFromFileChangeTool(tool) {
  if (Array.isArray(tool.changes) && tool.changes.length > 0) {
    return tool.changes.map((change) => {
      const diffText = change.diff || '';
      const lines = diffText.split('\n');
      let added = 0;
      let removed = 0;
      for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) added++;
        else if (line.startsWith('-') && !line.startsWith('---')) removed++;
      }
      return {
        path: change.path || '',
        name: fileNameFromPath(change.path),
        added,
        removed,
        lines,
      };
    });
  }
  return parseDiff(tool.text || '');
}

function SessionDetail({ session, project, liveEvents, optimisticUserMessages, running, pendingApproval, navigateTo }) {
  const turns = useMemo(() => session?.turns || [], [session?.turns]);
  const localUserMessages = useMemo(
    () => optimisticUserMessages.filter((message) => message.sessionId === session?.id),
    [optimisticUserMessages, session?.id],
  );
  const showLiveTurn = shouldRenderLiveTurn(liveEvents, running);
  const provider = providerLabel(session?.provider);
  const providerSessionId = session?.provider_session_id || session?.sessionId || session?.id || '';
  const model = session?.model || '';
  const lastLiveEvent = liveEvents[liveEvents.length - 1];
  const autoScrollWatchKey = [
    session?.updatedAt || '',
    turns.length,
    localUserMessages.map((message) => `${message.id}:${message.prompt}`).join('|'),
    liveEvents.length,
    lastLiveEvent?.method || lastLiveEvent?.agent_event_type || '',
    lastLiveEvent?.payload || lastLiveEvent?.text || lastLiveEvent?.error || '',
    running ? 'running' : 'idle',
    pendingApproval ? 'approval' : '',
  ].join(':');
  const {
    scrollRef,
    contentRef,
    showScrollButton,
    handleScroll,
    scrollToLatest,
  } = useSmartAutoScroll({
    resetKey: session?.id || providerSessionId,
    watchKey: autoScrollWatchKey,
  });

  const copyResumeCommand = useCallback(async () => {
    const resume = buildSessionResumeCommand(session);
    if (!resume.command) {
      toast.warning(resume.note);
      return;
    }
    try {
      await copyTextToClipboard(resume.command);
      toast.success('已复制 Codex resume 命令');
    } catch (err) {
      toast.error(err.message || '复制 resume 命令失败');
    }
  }, [session]);

  const downloadMarkdown = useCallback(() => {
    try {
      downloadTextFile(markdownFilenameForSession(session), sessionToMarkdown(session, { project, running }));
      toast.success('已下载 Markdown 转录');
    } catch (err) {
      toast.error(err.message || '下载 Markdown 失败');
    }
  }, [project, running, session]);

  return (
    <div className="session-detail-body">
      <div className="session-runtime-header">
        <div className="session-runtime-meta">
          <span>Provider: {provider}</span>
          <code title={providerSessionId}>{providerSessionId}</code>
        </div>
        <RuntimeStatusPill running={running} pendingApproval={pendingApproval} />
        <div className="session-runtime-actions">
          <div className="session-export-actions">
            <button type="button" onClick={copyResumeCommand} title="Codex 专用：复制 codex resume 命令">
              复制 resume 命令
            </button>
            <button type="button" onClick={downloadMarkdown}>下载 Markdown</button>
          </div>
          <CreateSessionIssueButton session={session} project={project} navigateTo={navigateTo} />
          <SessionInfoPopover
            session={session}
            provider={provider}
            sessionId={providerSessionId}
            model={model}
            navigateTo={navigateTo}
          />
        </div>
      </div>
      <SessionCommandReplay history={session?.command_history || []} navigateTo={navigateTo} />
      <div className="session-transcript" ref={scrollRef} onScroll={handleScroll}>
        <div className="session-transcript-content" ref={contentRef}>
          {turns.map((turn, index) => (
            <TurnItem
              key={turn.id || index}
              turn={turn}
              turnIndex={index}
            />
          ))}
          {localUserMessages.map((message) => (
            <OptimisticUserMessageBubble key={message.id} message={message} />
          ))}
          {showLiveTurn && (
            <LiveTurnItem
              liveEvents={liveEvents}
              persistedTurns={turns}
            />
          )}
        </div>
      </div>
      {showScrollButton && (
        <button type="button" className="session-scroll-bottom-button" onClick={scrollToLatest}>
          <ChevronDown size={14} />
          回到底部
        </button>
      )}
    </div>
  );
}


function SessionInfoPopover({ session, provider, sessionId, model, navigateTo }) {
  const linkedIssue = session?.linked_issue || null;
  const sourceIssues = session?.source_issues || [];
  const tokens = tokenSummary(session?.token_usage);
  return (
    <details className="session-info-popover">
      <summary className="session-info-trigger" title="查看会话信息" aria-label="查看会话信息">
        <Info size={14} />
      </summary>
      <div className="session-info-panel">
        <div className="session-info-section">
          <span className="session-info-section-title">Session</span>
          <InfoRow label="ID" value={<code>{displayValue(sessionId)}</code>} />
          <InfoRow label="Provider" value={displayValue(provider)} />
          <InfoRow label="Model" value={displayValue(model, '未提供')} />
        </div>
        <div className="session-info-section">
          <span className="session-info-section-title">关联 Issue</span>
          {linkedIssue ? (
            <>
              <InfoRow label="Issue" value={`#${linkedIssue.id} ${linkedIssue.title || '未命名'}`} />
              <InfoRow label="Status" value={displayValue(linkedIssue.status)} />
            </>
          ) : (
            <div className="session-info-empty">未关联</div>
          )}
        </div>
        <div className="session-info-section">
          <span className="session-info-section-title">由此讨论创建</span>
          {sourceIssues.length > 0 ? (
            sourceIssues.map((issue) => (
              <button
                key={issue.id}
                type="button"
                className="session-source-issue-link"
                onClick={() => navigateTo?.('issues', issue.id)}
              >
                <span>#{issue.id} {issue.title || '未命名'}</span>
                <ExternalLink size={12} />
              </button>
            ))
          ) : (
            <div className="session-info-empty">暂无来源型 Issue</div>
          )}
        </div>
        <div className="session-info-section">
          <span className="session-info-section-title">Token 使用</span>
          {tokens ? (
            <>
              <InfoRow label="Total" value={tokens.total} />
              <InfoRow label="Last turn" value={tokens.last} />
              <InfoRow label="Input / Output" value={`${tokens.input} / ${tokens.output}`} />
              <InfoRow label="Reasoning" value={tokens.reasoning} />
              {tokens.capturedAt && <InfoRow label="Updated" value={tokens.capturedAt} />}
            </>
          ) : (
            <div className="session-info-empty">暂无 token 数据</div>
          )}
        </div>
      </div>
    </details>
  );
}

function CreateSessionIssueButton({ session, project, navigateTo }) {
  const [creating, setCreating] = useState(false);

  const createIssue = async () => {
    if (creating) return;
    if (!project?.id) {
      toast.error('未找到当前 Session 对应的 Runner 项目，无法创建 Issue。');
      return;
    }
    setCreating(true);
    try {
      const selectedText = window.getSelection?.().toString() || '';
      const issue = await api.createIssue(buildSessionIssuePayload(session, project, { selectedText }));
      toast.success(`已创建 triage Issue #${issue.id}`);
      navigateTo?.('issues', issue.id);
    } catch (err) {
      toast.error(err.message || '从 Session 创建 Issue 失败');
    } finally {
      setCreating(false);
    }
  };

  return (
    <button
      type="button"
      className="session-source-issue-button"
      onClick={createIssue}
      disabled={creating}
      title="从 Session 创建 Issue"
    >
      {creating ? <Loader2 className="animate-spin" size={13} /> : <Plus size={13} />}
      从 Session 创建 Issue
    </button>
  );
}

function InfoRow({ label, value }) {
  return (
    <div className="session-info-row">
      <span className="session-info-label">{label}</span>
      <span className="session-info-value">{value}</span>
    </div>
  );
}

function RuntimeStatusPill({ running, pendingApproval }) {
  const status = pendingApproval ? 'approval' : running ? 'running' : 'idle';
  const label = pendingApproval ? '等待审批' : running ? 'Agent 正在运行 · 正在思考' : '空闲';
  return (
    <span className={`runtime-status-pill ${status}`}>
      <span className="runtime-status-dot" />
      {label}
    </span>
  );
}

function TurnItem({ turn, turnIndex }) {
  const elements = [];
  let currentTools = [];
  let toolGroupIndex = 0;
  let itemIndex = 0;

  for (const item of (turn.items || [])) {
    const itemKey = item.id || `${turnIndex}-${itemIndex}`;
    itemIndex += 1;
    if (item.type === 'userMessage' || item.type === 'agentMessage') {
      if (currentTools.length > 0) {
        elements.push(
          <ToolsCollapsible
            key={`${currentTools[0].item?.id || 'tools'}-${toolGroupIndex}-collapsible`}
            tools={currentTools}
          />,
        );
        currentTools = [];
        toolGroupIndex += 1;
      }
      if (item.type === 'userMessage') {
        elements.push(
          <UserMessageBubble
            key={itemKey}
            item={item}
          />,
        );
      } else {
        elements.push(
          <AgentMessageBubble
            key={itemKey}
            item={item}
          />,
        );
      }
    } else if (isRenderableToolItem(item)) {
      currentTools.push({ item });
    }
  }

  if (currentTools.length > 0) {
    elements.push(
      <ToolsCollapsible
        key={`${currentTools[0].item?.id || 'tools'}-${toolGroupIndex}-collapsible`}
        tools={currentTools}
      />,
    );
  }

  return (
    <div className="turn-container animate-fade-in">
      {elements}
    </div>
  );
}

function ToolsCollapsible({ tools, isLive }) {
  const [isOpen, setIsOpen] = useState(false);
  const normalizedTools = tools.map((tool) => (tool?.item ? tool.item : tool));

  const commandCount = normalizedTools.filter((item) => item.type === 'commandExecution').length;
  const fileCount = normalizedTools.filter((item) => item.type === 'fileChange').length;
  
  let summary = '执行了辅助工具';
  if (commandCount > 0 && fileCount > 0) {
    summary = `运行了 ${commandCount} 个终端命令，修改了 ${fileCount} 个文件`;
  } else if (commandCount > 0) {
    summary = `运行了 ${commandCount} 个终端命令`;
  } else if (fileCount > 0) {
    summary = `修改了 ${fileCount} 个文件`;
  }

  if (isLive) {
    summary = '正在执行工具以解决问题...';
  }

  return (
    <div className="tools-collapsible-wrapper">
      <button 
        className={`tools-trigger-btn ${isOpen ? 'open' : ''} ${isLive ? 'live' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        <span className="tools-trigger-left">
          <span className="tools-indicator-icon">
            <Settings size={13} className={isLive ? 'spin-animation' : ''} />
          </span>
          <span className="tools-trigger-text">{summary}</span>
        </span>
        <span className="tools-trigger-chevron">
          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>

      {isOpen && (
        <div className="tools-details-content animate-slide-down">
          {normalizedTools.map((item, idx) => (
            <ToolDetailItem
              key={item.id || idx}
              tool={item}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolDetailItem({ tool }) {
  if (tool.type === 'commandExecution') {
    return (
      <div className="tool-detail-item command">
        <div className="terminal-window">
          <div className="terminal-header">
            <div className="terminal-dots">
              <span className="dot red"></span>
              <span className="dot yellow"></span>
              <span className="dot green"></span>
            </div>
            <span className="terminal-title">zsh — {projectNameFromPath(tool.cwd || '')}</span>
          </div>
          <div className="terminal-body">
            <div className="terminal-prompt-line">
              <span className="terminal-prompt">macbook %</span>{' '}
              <span className="terminal-command-text">{tool.command || tool.text}</span>
            </div>
            {tool.text && tool.text !== tool.command && (
              <pre className="terminal-output">{tool.text}</pre>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (tool.type === 'fileChange') {
    const files = filesFromFileChangeTool(tool);

    if (files.length === 0) {
      const diffText = tool.text || '';
      return (
        <div className="tool-detail-item file-change">
          <div className="diff-file-card">
            <div className="diff-file-header">
              <span className="diff-file-icon"><FileCode size={14} /></span>
              <span className="diff-file-path">文件改动详情</span>
            </div>
            <div className="diff-file-body" style={{ padding: '12px 14px' }}>
              {diffText ? (
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: '0.76rem', color: 'var(--text-secondary)' }}>{diffText}</pre>
              ) : (
                <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem', fontStyle: 'italic' }}>无具体的代码差异（可能是新增空白文件、修改文件属性或未完成保存）</span>
              )}
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="tool-detail-item file-change">
        {files.map((file, fIdx) => (
          <div key={fIdx} className="diff-file-card">
            <div className="diff-file-header">
              <span className="diff-file-icon"><FileCode size={14} /></span>
              <span className="diff-file-path" title={file.path}>{file.name}</span>
              <div className="diff-file-badges">
                <span className="diff-badge added">+{file.added}</span>
                <span className="diff-badge removed">-{file.removed}</span>
              </div>
            </div>
            <div className="diff-file-body">
              {file.lines.map((line, lIdx) => {
                let lineClass = 'diff-line';
                if (line.startsWith('+') && !line.startsWith('+++')) lineClass += ' added';
                else if (line.startsWith('-') && !line.startsWith('---')) lineClass += ' removed';
                else if (line.startsWith('@@')) lineClass += ' meta';
                return (
                  <div key={lIdx} className={lineClass}>
                    {line}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    );
  }

  const display = toolDisplayForItem(tool);
  if (!display) return null;

  return (
    <div className={`tool-detail-item ${display.kind || 'generic'}`}>
      <div className="generic-tool-card">
        <div className="generic-tool-title">{display.title}</div>
        <pre className="generic-tool-body">{display.body}</pre>
      </div>
    </div>
  );
}

function UserMessageBubble({ item }) {
  const text = textFromUserContent(item.content);
  return (
    <div className="chat-bubble-container user">
      <div className="chat-bubble-content">
        <div className="chat-bubble-body">
          <MarkdownText text={text} />
        </div>
      </div>
    </div>
  );
}

function OptimisticUserMessageBubble({ message }) {
  return (
    <UserMessageBubble
      item={{ type: 'userMessage', content: [{ type: 'input_text', text: message.prompt }] }}
    />
  );
}

function AgentMessageBubble({ item }) {
  const text = item.text || '';
  return (
    <div className="chat-bubble-container agent animate-fade-in">
      <div className="chat-bubble-avatar agent-logo">A</div>
      <div className="chat-bubble-content">
        <div className="chat-bubble-sender">Agent</div>
        <div className="chat-bubble-body">
          <MarkdownText text={text} />
        </div>
      </div>
    </div>
  );
}

function LiveTurnItem({ liveEvents, persistedTurns }) {
  const parsed = useMemo(() => parseLiveSessionEvents(liveEvents, persistedTurns), [liveEvents, persistedTurns]);

  const { tools, agentMessageText, agentMessageDeduped, reasoningText, errorText, approvalPending, activity } = parsed;
  const showThinking = !agentMessageDeduped && !agentMessageText && !errorText;

  return (
    <div className="turn-container active-live">
      <LiveActivityBanner activity={activity} approvalPending={approvalPending} errorText={errorText} />
      {tools.length > 0 && (
        <ToolsCollapsible
          tools={tools}
          isLive={true}
        />
      )}
      
      {reasoningText && (
        <div className="live-reasoning-card">
          <span>Reasoning summary</span>
          <p>{reasoningText}</p>
        </div>
      )}

      {showThinking && (
        <div className="chat-bubble-container agent streaming">
          <div className="chat-bubble-avatar agent-logo live-pulse">A</div>
          <div className="chat-bubble-content">
            <div className="chat-bubble-sender">Agent <span className="streaming-badge">Thinking...</span></div>
            <div className="chat-bubble-body thinking-placeholder">
              <span>正在思考中</span>
              <span className="typing-dots"><i></i><i></i><i></i></span>
            </div>
          </div>
        </div>
      )}

      {agentMessageText && (
        <div className="chat-bubble-container agent streaming">
          <div className="chat-bubble-avatar agent-logo live-pulse">A</div>
          <div className="chat-bubble-content">
            <div className="chat-bubble-sender">Agent <span className="streaming-badge">Thinking...</span></div>
            <div className="chat-bubble-body">
              <MarkdownText text={agentMessageText} />
            </div>
          </div>
        </div>
      )}

      {errorText && (
        <span className="sr-only">{errorText}</span>
      )}
    </div>
  );
}

function LiveActivityBanner({ activity, approvalPending, errorText }) {
  if (errorText) return <div className="live-activity-banner error">Codex 运行出错：{errorText}</div>;
  if (approvalPending) return <div className="live-activity-banner approval">Codex 已暂停，正在等待网页审批。</div>;
  const label = liveActivityLabel(activity);
  return <div className="live-activity-banner"><Loader2 size={13} className="spin-animation" /> {label}</div>;
}

function liveActivityLabel(activity) {
  switch (activity) {
    case 'streaming':
      return 'Codex is working · 正在输出回复';
    case 'command':
      return 'Codex is working · 正在运行命令';
    case 'file-change':
      return 'Codex is working · 正在整理文件改动';
    default:
      return 'Agent is running · 正在思考';
  }
}

function MarkdownText({ text }) {
  return <MarkdownPreview text={text || ''} className="session-markdown" />;
}
