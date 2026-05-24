import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { 
  ChevronDown, ChevronRight, FileCode, Info, Loader2, Plus, Settings,
  Pin, Search, MessageSquarePlus,
  SlidersHorizontal, ShieldAlert, Brain, ArrowUp, Folder
} from 'lucide-react';
import { api } from '../api/client';
import { message as toast } from '../store/toastStore';
import MarkdownPreview from '../components/editor/MarkdownPreview';
import { localImagePathToAttachmentMarkdown } from '../components/editor/attachments';
import { selectProjects, selectSetProjects, useDataStore } from '../store/dataStore';
import ApprovalDialog from './sessions/ApprovalDialog';
import { PROJECT_REQUIRED_MESSAGE, canCreateSession, resolveLastSessionProject } from './sessions/newSessionGuards';
import SessionComposer from './sessions/SessionComposer';
import {
  defaultMessageSettings,
  defaultSessionSettings,
  modelLabel,
  providerSupports,
  providerLabel as projectProviderLabel,
} from './sessions/sessionOptions';
import VirtualSessionList from './sessions/VirtualSessionList';
import { orderedProjectsAfterMove } from './sessions/projectOrder';
import { useSmartAutoScroll } from './sessions/smartAutoScroll';
import { isRenderableToolItem, parseLiveSessionEvents, shouldRenderLiveTurn, toolDisplayForItem } from './sessions/sessionTranscriptItems';
import './sessions/Sessions.css';
import './sessions/SessionsClient.css';

const PAGE_SIZE = 50;
const SESSION_DETAIL_REFRESH_DELAY_MS = 250;
const SESSION_LIST_REFRESH_DELAY_MS = 800;
const DEFAULT_SESSION_PROVIDER = 'codex';
const SESSION_SIDEBAR_WIDTH_KEY = 'codex-session-sidebar-width';
const SESSION_SIDEBAR_DEFAULT_WIDTH = 260;
const SESSION_SIDEBAR_MIN_WIDTH = 220;
const SESSION_SIDEBAR_MAX_WIDTH = 420;
const SESSION_DETAIL_MIN_WIDTH = 420;
const SESSION_RESIZE_HANDLE_WIDTH = 8;
const SESSION_SIDEBAR_KEY_STEP = 16;

function clampSessionSidebarWidth(width, containerWidth = 0) {
  const fallback = SESSION_SIDEBAR_DEFAULT_WIDTH;
  const parsedWidth = width == null || (typeof width === 'string' && width.trim() === '') ? NaN : Number(width);
  const resolved = Number.isFinite(parsedWidth) ? parsedWidth : fallback;
  const availableMax = containerWidth > 0
    ? containerWidth - SESSION_DETAIL_MIN_WIDTH - SESSION_RESIZE_HANDLE_WIDTH
    : SESSION_SIDEBAR_MAX_WIDTH;
  const maxWidth = Math.min(SESSION_SIDEBAR_MAX_WIDTH, Math.max(SESSION_SIDEBAR_MIN_WIDTH, availableMax));
  return Math.round(Math.min(Math.max(resolved, SESSION_SIDEBAR_MIN_WIDTH), maxWidth));
}

function readSessionSidebarWidth() {
  try {
    return clampSessionSidebarWidth(window.localStorage.getItem(SESSION_SIDEBAR_WIDTH_KEY));
  } catch {
    return SESSION_SIDEBAR_DEFAULT_WIDTH;
  }
}

function persistSessionSidebarWidth(width) {
  try {
    window.localStorage.setItem(SESSION_SIDEBAR_WIDTH_KEY, String(Math.round(width)));
  } catch {
    // localStorage 不可用时忽略，拖拽本身仍可用。
  }
}

function textFromUserContent(content) {
  if (!Array.isArray(content)) return '';
  return content.map((item) => {
    if (item.type === 'text' || item.type === 'input_text') return item.text || '';
    if (item.type === 'localImage') return localImagePathToAttachmentMarkdown(item.path);
    if (item.type === 'image' || item.type === 'input_image') return `![image](${item.url || item.image_url || ''})`;
    return '';
  }).filter(Boolean).join('\n\n');
}

function compactModelName(value) {
  return String(value || '')
    .replace(/^gpt[-\s]*/i, '')
    .replace(/^GPT[-\s]*/i, '')
    .replace(/-/g, ' ')
    .trim();
}

export default function Sessions() {
  const projects = useDataStore(selectProjects);
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
  const [sessionSettings, setSessionSettings] = useState(() => defaultSessionSettings(null));
  const [messageSettings, setMessageSettings] = useState(() => defaultMessageSettings(null));
  const [models, setModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [liveEvents, setLiveEvents] = useState([]);
  const [sessionRunning, setSessionRunning] = useState(false);
  const [approvalRequest, setApprovalRequest] = useState(null);
  const [approvalNotice, setApprovalNotice] = useState(null);
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const [savingProjectOrder, setSavingProjectOrder] = useState(false);
  const detailRefreshTimer = useRef(null);
  const listRefreshTimer = useRef(null);
  const selectedIdRef = useRef(selectedId);
  const lastSelectedIdRef = useRef(selectedId);
  const containerRef = useRef(null);
  const resizingSidebarRef = useRef(false);
  const [sessionSidebarWidth, setSessionSidebarWidth] = useState(readSessionSidebarWidth);
  const sessionSidebarWidthRef = useRef(sessionSidebarWidth);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const applySessionSidebarWidth = useCallback((width) => {
    const nextWidth = Math.round(width);
    sessionSidebarWidthRef.current = nextWidth;
    containerRef.current?.style.setProperty('--sessions-sidebar-width', `${nextWidth}px`);
  }, []);

  const updateSessionSidebarWidthFromPointer = useCallback((clientX) => {
    const rect = containerRef.current?.getBoundingClientRect();
    const nextWidth = clampSessionSidebarWidth(clientX - (rect?.left || 0), rect?.width || 0);
    applySessionSidebarWidth(nextWidth);
  }, [applySessionSidebarWidth]);

  const finishSessionSidebarResize = useCallback((event) => {
    if (!resizingSidebarRef.current) return;
    resizingSidebarRef.current = false;
    setIsResizingSidebar(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const nextWidth = sessionSidebarWidthRef.current;
    setSessionSidebarWidth(nextWidth);
    persistSessionSidebarWidth(nextWidth);
  }, []);

  const handleSessionSidebarResizeStart = useCallback((event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizingSidebarRef.current = true;
    setIsResizingSidebar(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    updateSessionSidebarWidthFromPointer(event.clientX);
  }, [updateSessionSidebarWidthFromPointer]);

  const handleSessionSidebarResizeMove = useCallback((event) => {
    if (!resizingSidebarRef.current) return;
    event.preventDefault();
    updateSessionSidebarWidthFromPointer(event.clientX);
  }, [updateSessionSidebarWidthFromPointer]);

  const handleSessionSidebarResizeKeyDown = useCallback((event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const containerWidth = containerRef.current?.getBoundingClientRect().width || 0;
    const current = sessionSidebarWidthRef.current;
    const target = {
      ArrowLeft: current - SESSION_SIDEBAR_KEY_STEP,
      ArrowRight: current + SESSION_SIDEBAR_KEY_STEP,
      Home: SESSION_SIDEBAR_MIN_WIDTH,
      End: SESSION_SIDEBAR_MAX_WIDTH,
    }[event.key];
    const nextWidth = clampSessionSidebarWidth(target, containerWidth);
    applySessionSidebarWidth(nextWidth);
    setSessionSidebarWidth(nextWidth);
    persistSessionSidebarWidth(nextWidth);
  }, [applySessionSidebarWidth]);

  useEffect(() => {
    const clampToContainer = () => {
      const containerWidth = containerRef.current?.getBoundingClientRect().width || 0;
      if (window.innerWidth <= 960) return;
      const nextWidth = clampSessionSidebarWidth(sessionSidebarWidthRef.current, containerWidth);
      if (nextWidth === sessionSidebarWidthRef.current) return;
      applySessionSidebarWidth(nextWidth);
      setSessionSidebarWidth(nextWidth);
    };
    clampToContainer();
    window.addEventListener('resize', clampToContainer);
    return () => window.removeEventListener('resize', clampToContainer);
  }, [applySessionSidebarWidth]);

  // 客户端风格路由、置顶与搜索状态
  const [activeView, setActiveView] = useState('chat');
  const [searchTerm, setSearchTerm] = useState('');
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

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.getSessions({ limit: PAGE_SIZE });
      const data = result.data || [];
      setSessions(data);
      setCursor(result.nextCursor || '');
      setSelectedId((current) => current || data[0]?.id || '');
    } catch (err) {
      toast.error(err.message || '加载 provider sessions 失败');
    } finally {
      setLoading(false);
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

  useEffect(() => { loadModels(); }, [loadModels]);
  useEffect(() => { setMessageSettings(defaultMessageSettings(selectedSessionProject)); }, [selectedId, selectedSessionProject]);

  const scheduleListRefresh = useCallback(() => {
    window.clearTimeout(listRefreshTimer.current);
    listRefreshTimer.current = window.setTimeout(loadFirstPage, SESSION_LIST_REFRESH_DELAY_MS);
  }, [loadFirstPage]);

  const scheduleSelectedRefresh = useCallback((threadId) => {
    const eventKey = providerSessionKey(DEFAULT_SESSION_PROVIDER, threadId);
    if (!threadId || eventKey !== selectedId) return;
    window.clearTimeout(detailRefreshTimer.current);
    detailRefreshTimer.current = window.setTimeout(loadSelected, SESSION_DETAIL_REFRESH_DELAY_MS);
  }, [loadSelected, selectedId]);

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
      const requestSessionKey = eventKey || eventSessionKeyFromPayload(request);
      setApprovalNotice({ request, sessionId: requestSessionKey });
      if (!requestSessionKey || requestSessionKey === selectedIdRef.current) {
        setApprovalRequest(request);
      } else {
        toast.info('Codex 正在等待审批，切回对应 session 后可处理。');
      }
    }
    if (event.threadId && isSessionStartEvent(event)) {
      setSessions((prev) => setSessionRunningInList(prev, eventKey, true));
    }
    if (event.threadId && isSessionStopEvent(event)) {
      setSessions((prev) => setSessionRunningInList(prev, eventKey, false));
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
      setApprovalNotice((current) => current?.sessionId === stoppedSessionId ? null : current);
      setApprovalRequest((current) => {
        if (!current) return current;
        const currentSessionId = eventSessionKeyFromPayload(current);
        if (!currentSessionId || currentSessionId === stoppedSessionId) return null;
        return current;
      });
      loadSelected().then(() => {
        if (selectedIdRef.current === stoppedSessionId) setLiveEvents([]);
      });
      loadFirstPage();
    }
  }), [loadFirstPage, loadSelected, scheduleListRefresh, scheduleSelectedRefresh, selectedId]);

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
      setApprovalRequest(null);
      setApprovalNotice(null);
    } catch (err) {
      toast.error(err.message || '提交授权决策失败');
    } finally {
      setApprovalSubmitting(false);
    }
  };

  const sendMessage = async (event) => {
    event.preventDefault();
    if (!selectedId || !message.trim()) return;
    setSending(true);
    try {
      await api.sendSessionMessage(selectedId, {
        prompt: message,
        model: messageSettings.model,
        reasoning_effort: messageSettings.reasoningEffort,
        approval_policy: messageSettings.approvalPolicy,
        sandbox: messageSettings.sandbox,
      });
      setSessionRunning(true);
      setSessions((prev) => setSessionRunningInList(prev, selectedId, true));
      setMessage('');
      setLiveEvents([]);
    } catch (err) {
      toast.error(err.message || '发送消息失败');
    } finally {
      setSending(false);
    }
  };

  const interrupt = async () => {
    if (!selectedId) return;
    await api.interruptSession(selectedId);
    setSessionRunning(false);
    setSessions((prev) => setSessionRunningInList(prev, selectedId, false));
  };

  // 新建并启动会话
  const handleCreateNewSession = async (e) => {
    if (e) e.preventDefault();
    if (sending) return;
    const guard = canCreateSession({ projectId, cwd, prompt, selectedProject });
    if (!guard.ok) {
      if (guard.reason === 'missing_project' || guard.reason === 'unsupported_provider') {
        toast.error(guard.message || PROJECT_REQUIRED_MESSAGE);
      }
      return;
    }
    setSending(true);
    try {
      const result = await api.createSession({
        project_id: projectId,
        cwd,
        prompt: prompt,
        model: sessionSettings.model,
        reasoning_effort: sessionSettings.reasoningEffort,
        approval_policy: sessionSettings.approvalPolicy,
        sandbox: sessionSettings.sandbox,
      });
      const newSessionId = sessionIDFromCreateResult(result);
      setSelectedId(newSessionId);
      setSessionRunning(Boolean(result.turn_id));
      setSessions((prev) => setSessionRunningInList(prev, newSessionId, Boolean(result.turn_id)));
      setLiveEvents([]);
      setPrompt('');
      await loadFirstPage();
    } catch (err) {
      toast.error(err.message || '创建 session 失败');
    } finally {
      setSending(false);
    }
  };

  // 标题中项目名的过滤
  const filteredSessions = useMemo(() => {
    let result = sessions;
    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      result = result.filter(
        (s) => 
          (s.name && s.name.toLowerCase().includes(term)) || 
          (s.preview && s.preview.toLowerCase().includes(term))
      );
    }
    return result;
  }, [sessions, searchTerm]);

  // 已置顶的会话
  const pinnedSessions = useMemo(() => {
    return sessions.filter((s) => pinnedSessionIds.includes(s.id));
  }, [sessions, pinnedSessionIds]);

  const selectSession = useCallback((id) => {
    const nextSession = sessions.find((item) => item.id === id);
    setSelectedId(id);
    setActiveView('chat');
    setLiveEvents([]);
    setSessionRunning(isSessionRunning(nextSession));
    setApprovalRequest(approvalNotice?.sessionId === id ? approvalNotice.request : null);
  }, [approvalNotice, sessions]);

  if (loading && sessions.length === 0) {
    return <LoadingState />;
  }

  return (
    <div
      ref={containerRef}
      className={`sessions-client-container client-animate-fade-in${isResizingSidebar ? ' resizing-session-sidebar' : ''}`}
      style={{ '--sessions-sidebar-width': `${sessionSidebarWidth}px` }}
    >
      {/* 左侧 macOS 风格侧边栏 */}
      <aside className="sessions-client-sidebar">


        {/* 快捷菜单项 */}
        <div className="sidebar-shortcut-items">
          <button 
            className={`sidebar-shortcut-item ${activeView === 'new' ? 'active' : ''}`}
            onClick={() => { setSelectedId(''); setActiveView('new'); setPrompt(''); setSessionRunning(false); }}
          >
            <span className="sidebar-shortcut-item-icon"><MessageSquarePlus size={16} /></span>
            <span>新对话</span>
          </button>
          
          <button 
            className={`sidebar-shortcut-item ${activeView === 'search' ? 'active' : ''}`}
            onClick={() => { setActiveView(activeView === 'search' ? 'new' : 'search'); }}
          >
            <span className="sidebar-shortcut-item-icon"><Search size={16} /></span>
            <span>搜索</span>
          </button>
          
        </div>

        {/* 搜索框 */}
        {activeView === 'search' && (
          <div style={{ padding: '0 4px 10px 4px' }}>
            <input
              type="text"
              className="form-control"
              placeholder="搜索历史会话..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{ height: '32px', fontSize: '0.8rem', borderRadius: '8px', border: '1px solid rgba(0,0,0,0.1)', padding: '0 10px', width: '100%', background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
              autoFocus
            />
          </div>
        )}

        {/* 置顶会话列表 */}
        {pinnedSessions.length > 0 && (
          <>
            <div className="sidebar-section-title">置顶</div>
            <div className="pinned-sessions-list">
              {pinnedSessions.map((s) => (
                <button 
                  key={s.id} 
                  className={`pinned-session-row ${selectedId === s.id && activeView === 'chat' ? 'active' : ''}`}
                  onClick={() => selectSession(s.id)}
                >
                  <span className="pinned-title" title={s.name || s.preview}>{s.name || s.preview || '未命名 Codex 会话'}</span>
                  <div className="pinned-actions">
                    <span className="session-provider-pill">{providerLabel(s.provider)}</span>
                    <SessionOriginBadge origin={s.origin} />
                    <button 
                      className="pinned-action-btn" 
                      onClick={(e) => togglePinSession(s.id, e)} 
                      title="取消置顶"
                    >
                      <Pin size={11} fill="currentColor" style={{ transform: 'rotate(45deg)', color: 'var(--primary)' }} />
                    </button>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        {/* 项目会话列表 */}
        <SessionOriginLegend />
        <div className="sidebar-section-title">项目</div>
        <div className="sidebar-scroll-area">
          <VirtualSessionList
            sessions={filteredSessions}
            projects={projects}
            selectedId={selectedId}
            hasMore={Boolean(cursor)}
            loadingMore={loadingMore}
            savingOrder={savingProjectOrder}
            autoCollapseEmptyProjects={!searchTerm.trim()}
            onSelect={selectSession}
            onLoadMore={loadMore}
            onReorderProjects={handleReorderProjects}
          />
        </div>


      </aside>

      <div
        className="sessions-sidebar-resize-handle"
        role="separator"
        aria-label="调整 session 列表宽度"
        aria-orientation="vertical"
        aria-valuemin={SESSION_SIDEBAR_MIN_WIDTH}
        aria-valuemax={SESSION_SIDEBAR_MAX_WIDTH}
        aria-valuenow={sessionSidebarWidth}
        tabIndex={0}
        onPointerDown={handleSessionSidebarResizeStart}
        onPointerMove={handleSessionSidebarResizeMove}
        onPointerUp={finishSessionSidebarResize}
        onPointerCancel={finishSessionSidebarResize}
        onKeyDown={handleSessionSidebarResizeKeyDown}
      />

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
                  liveEvents={liveEvents}
                  running={sessionRunning}
                  pendingApproval={approvalNotice?.sessionId === selectedId}
                />
              ) : (
                <EmptyDetail />
              )}
              
              <div className="client-chat-composer-section">
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
                  selectedId={selectedId}
                  onSubmit={sendMessage}
                  onStop={interrupt}
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
                <textarea
                  className="new-session-textarea"
                  placeholder="尽管问"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleCreateNewSession();
                    }
                  }}
                />

                <div className="new-session-composer-footer">
                  <div className="new-session-composer-left">
                    <button type="button" className="composer-icon-btn" title="添加文件附件">
                      <Plus size={16} />
                    </button>
                    
                    {/* 精致的审批权限配置 */}
                    <div className="composer-embedded-select danger">
                      <ShieldAlert size={13} />
                      <span>{sessionSettings.approvalPolicy === 'never' ? '完全访问权限' : '工作区写入'}</span>
                      <select 
                        value={`${sessionSettings.sandbox}|${sessionSettings.approvalPolicy}`} 
                        onChange={(e) => {
                          const [sandbox, approvalPolicy] = e.target.value.split('|');
                          handleSettingChange('sandbox', sandbox);
                          handleSettingChange('approvalPolicy', approvalPolicy);
                        }}
                      >
                        <option value="danger-full-access|never">完全访问权限</option>
                        <option value="workspace-write|never">工作区写入</option>
                        <option value="workspace-write|danger-only">按需授权</option>
                        <option value="workspace-write|always">每次授权</option>
                        <option value="read-only|always">只读模式</option>
                      </select>
                    </div>
                  </div>

                  <div className="new-session-composer-right">
                    {/* 精致推理模型配置 */}
                    <div className="composer-embedded-select">
                      <Brain size={13} />
                      <span>{sessionSettings.model ? compactModelName(sessionSettings.model) : '5.5 超高'}</span>
                      <select 
                        value={sessionSettings.model} 
                        onChange={(e) => handleSettingChange('model', e.target.value)}
                      >
                        <option value="">Codex 默认</option>
                        {models.map((model) => (
                          <option key={model.id || model.model} value={model.id || model.model}>
                            {compactModelName(modelLabel(model))}
                          </option>
                        ))}
                      </select>
                    </div>



                    <button 
                      type="button" 
                      className="composer-circle-submit" 
                      disabled={sending || !prompt.trim()} 
                      onClick={handleCreateNewSession}
                      title="发送并新建会话"
                    >
                      {sending ? <Loader2 className="animate-spin" size={16} /> : <ArrowUp size={16} strokeWidth={2.4} />}
                    </button>
                  </div>
                </div>
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

      <ApprovalDialog request={approvalRequest} submitting={approvalSubmitting} onResolve={resolveApproval} />
    </div>
  );
}

function parseApprovalPayload(payload) {
  try {
    const request = JSON.parse(payload || '{}');
    return { id: request.id || '', method: request.method || 'approval/requested', params: request.params || {} };
  } catch {
    return { id: '', method: 'approval/requested', params: {} };
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

function isSessionStopEvent(event) {
  return event?.agent_event_type === 'agent.turn.completed' ||
    event?.agent_event_type === 'agent.error' ||
    event?.method === 'turn/completed' ||
    event?.method === 'error';
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

function SessionOriginBadge({ origin }) {
  const meta = sessionOriginMeta(origin);
  return <span className={`session-origin-dot ${meta.className}`} title={meta.title} />;
}

function sessionOriginMeta(origin) {
  if (origin === 'runner') {
    return { className: 'runner', label: 'Runner', title: 'Runner：由 codex-issue-runner 创建或执行' };
  }
  return { className: 'codex-app', label: 'Codex App', title: 'Codex App：来自 Codex App / CLI 会话' };
}

function SessionOriginLegend() {
  return (
    <div className="session-origin-legend" aria-label="Session 来源说明">
      <span className="session-origin-legend-item">
        <span className="session-origin-dot codex-app" /> Codex App
      </span>
      <span className="session-origin-legend-item">
        <span className="session-origin-dot runner" /> Runner
      </span>
    </div>
  );
}

function mergeSessions(prev, next) {
  const seen = new Set(prev.map((item) => item.id));
  return [...prev, ...next.filter((item) => !seen.has(item.id))];
}

function isSessionRunning(session) {
  if (!session) return false;
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

function SessionDetail({ session, liveEvents, running, pendingApproval }) {
  const turns = session?.turns || [];
  const showLiveTurn = shouldRenderLiveTurn(liveEvents, running);
  const provider = providerLabel(session?.provider);
  const providerSessionId = session?.provider_session_id || session?.sessionId || session?.id || '';
  const model = session?.model || '';
  const lastLiveEvent = liveEvents[liveEvents.length - 1];
  const autoScrollWatchKey = [
    session?.updatedAt || '',
    turns.length,
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

  return (
    <div className="session-detail-body">
      <div className="session-runtime-header">
        <span>Provider: {provider}</span>
        <code>{providerSessionId}</code>
        <RuntimeStatusPill running={running} pendingApproval={pendingApproval} />
        <SessionInfoPopover
          session={session}
          provider={provider}
          sessionId={providerSessionId}
          model={model}
        />
      </div>
      <div className="session-transcript" ref={scrollRef} onScroll={handleScroll}>
        <div className="session-transcript-content" ref={contentRef}>
          {turns.map((turn, index) => (
            <TurnItem key={turn.id || index} turn={turn} />
          ))}
          {showLiveTurn && <LiveTurnItem liveEvents={liveEvents} />}
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

function SessionInfoPopover({ session, provider, sessionId, model }) {
  const linkedIssue = session?.linked_issue || null;
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
  const label = pendingApproval ? '等待审批' : running ? 'Agent is running · 正在思考' : 'Idle';
  return (
    <span className={`runtime-status-pill ${status}`}>
      <span className="runtime-status-dot" />
      {label}
    </span>
  );
}

function TurnItem({ turn }) {
  const elements = [];
  let currentTools = [];

  for (const item of (turn.items || [])) {
    if (item.type === 'userMessage' || item.type === 'agentMessage') {
      if (currentTools.length > 0) {
        elements.push(<ToolsCollapsible key={`${currentTools[0].id || 'tools'}-collapsible`} tools={currentTools} />);
        currentTools = [];
      }
      if (item.type === 'userMessage') {
        elements.push(<UserMessageBubble key={item.id} item={item} />);
      } else {
        elements.push(<AgentMessageBubble key={item.id} item={item} />);
      }
    } else if (isRenderableToolItem(item)) {
      currentTools.push(item);
    }
  }

  if (currentTools.length > 0) {
    elements.push(<ToolsCollapsible key={`${currentTools[0].id || 'tools'}-collapsible`} tools={currentTools} />);
  }

  return (
    <div className="turn-container animate-fade-in">
      {elements}
    </div>
  );
}

function ToolsCollapsible({ tools, isLive }) {
  const [isOpen, setIsOpen] = useState(false);

  const commandCount = tools.filter(t => t.type === 'commandExecution').length;
  const fileCount = tools.filter(t => t.type === 'fileChange').length;
  
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
          {tools.map((tool, idx) => (
            <ToolDetailItem key={idx} tool={tool} />
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
    let files;
    if (Array.isArray(tool.changes) && tool.changes.length > 0) {
      files = tool.changes.map((c) => {
        const fullPath = c.path || '';
        const name = fullPath.split('/').pop() || fullPath;
        const diffText = c.diff || '';
        const lines = diffText.split('\n');
        let added = 0;
        let removed = 0;
        for (const line of lines) {
          if (line.startsWith('+') && !line.startsWith('+++')) added++;
          else if (line.startsWith('-') && !line.startsWith('---')) removed++;
        }
        return {
          path: fullPath,
          name: name,
          added,
          removed,
          lines,
        };
      });
    } else {
      const diffText = tool.text || '';
      files = parseDiff(diffText);
    }

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

function LiveTurnItem({ liveEvents }) {
  const parsed = useMemo(() => parseLiveSessionEvents(liveEvents), [liveEvents]);

  const { tools, agentMessageText, reasoningText, errorText, approvalPending, activity } = parsed;
  const showThinking = !agentMessageText && !errorText;

  return (
    <div className="turn-container active-live">
      <LiveActivityBanner activity={activity} approvalPending={approvalPending} errorText={errorText} />
      {tools.length > 0 && <ToolsCollapsible tools={tools} isLive={true} />}
      
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
