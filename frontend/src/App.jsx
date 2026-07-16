import { eventsApi } from './api/events.js';
import { lazy, Suspense, useCallback, useEffect } from 'react';
import { useImmer } from 'use-immer';
import { systemApi } from './api/system.js';
import { getAuthToken } from './api/authToken';
import { assistantModuleForPage, isAssistantModulePage } from './pages/assistantModules';
import AppSidebar from './components/AppSidebar';
import GuardianAlertBanner from './components/GuardianAlertBanner';
import TurtleLoader from './components/TurtleLoader';
import {
  selectLoading,
  selectRefreshData,
  selectSetBackendOnline,
  useDataStore,
} from './store/dataStore';
import { RECONCILE_INTERVAL_MS } from './utils/stateGuards';
import { Menu } from 'lucide-react';
import ToastContainer from './components/ToastContainer';
import AuthGate from './components/AuthGate';
import { resolveWorkBoardPage } from './pages/workBoardModel.js';
import { resolveRunsPage } from './pages/runs/runPageModel.js';
import { handoffRouteFromHash } from './pages/handoffPageModel.js';
import './App.css';
import './GeekWorkbench.css';
import './GeekWorkbenchPages.css';

// 页面仅在用户实际访问时下载，避免 Dashboard 首屏载入编辑器和会话历史等重型依赖。
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Projects = lazy(() => import('./pages/Projects'));
const WorkBoard = lazy(() => import('./pages/WorkBoard'));
const Issues = lazy(() => import('./pages/Issues'));
const IssueDetail = lazy(() => import('./pages/IssueDetail'));
const Runs = lazy(() => import('./pages/Runs'));
const Handoffs = lazy(() => import('./pages/Handoffs'));
const PiChat = lazy(() => import('./pages/PiChat'));
const AttentionInbox = lazy(() => import('./pages/AttentionInbox'));
const Cron = lazy(() => import('./pages/Cron'));
const Settings = lazy(() => import('./pages/Settings'));

const ACTIVE_RECONCILE_EVENT_TYPES = new Set([
  'issue.created',
  'issue.status_changed',
  'issue.error',
  'issue.runtime_updated',
  'runner.started',
  'runner.stopped',
  'runner.hold',
  'runner.hold_active',
  'runner.hold_check.failed',
  'runner.hold_cleared',
  'cron_task.ran',
  'cron_task.error',
]);

const PAGE_DATA_SLICES = {
  cron: ['cronTasks'],
  dashboard: ['projects', 'issues'],
  issues: ['issues'],
  projects: ['projects', 'issues'],
  work: ['projects'],
  handoffs: ['projects'],
};

function getReconcileSlices(currentPage, selectedIssueId) {
  // IssueDetail 自己读取单条 issue；不要在详情页额外轮询整张 issues 列表。
  if (currentPage === 'issues' && selectedIssueId) return [];
  return PAGE_DATA_SLICES[currentPage] || [];
}

function PageLoadingFallback() {
  return (
    <div className="app-loading-stage" role="status" aria-live="polite">
      <TurtleLoader label="正在加载页面…" />
    </div>
  );
}

export default function App() {
  const initialHandoffRoute = handoffRouteFromHash(globalThis.location?.hash);
  const [appState, updateAppState] = useImmer(() => ({
    // 路由与过滤状态
    currentPage: initialHandoffRoute?.page || 'dashboard', // 默认进入 Dashboard，通知深链进入对应 Handoff
    selectedIssueId: null,
    selectedRunId: '',
    selectedSessionId: '',
    selectedHandoffId: initialHandoffRoute?.handoffId || '',
    filterProject: '', // '' 表示 Any project
    focusFilter: 'all', // 'all' | 'triage' | 'active' | 'failed' | 'archive'

    // 新增 Issue 弹窗的全局状态（可以从侧边栏 + 看板列头触发）
    isNewIssueOpen: false,
    prefilledStatus: 'triage',
    newIssueSource: null,

    // 主题状态 (默认亮色以匹配截图，支持一键切换)
    theme: localStorage.getItem('codex-theme') || 'light',

    // 侧边栏折叠状态
    sidebarCollapsed: localStorage.getItem('codex-sidebar-collapsed') === 'true',

    // 远程访问 token 第一阶段：本地保存后才发起 API 请求
    authReady: Boolean(getAuthToken()),
  }));

  const loading = useDataStore(selectLoading);
  const refreshData = useDataStore(selectRefreshData);
  const setBackendOnline = useDataStore(selectSetBackendOnline);

  const {
    currentPage,
    selectedIssueId,
    selectedRunId,
    selectedSessionId,
    selectedHandoffId,
    filterProject,
    focusFilter,
    isNewIssueOpen,
    prefilledStatus,
    newIssueSource,
    theme,
    sidebarCollapsed,
    authReady,
  } = appState;

  const setAuthReady = useCallback(() => {
    return systemApi.validateAuthToken()
      .then(() => {
        updateAppState(draft => {
          draft.authReady = true;
        });
      })
      .catch((err) => {
        systemApi.clearAuthToken();
        updateAppState(draft => {
          draft.authReady = false;
        });
        throw err;
      });
  }, [updateAppState]);

  const setIsNewIssueOpen = useCallback((open) => {
    updateAppState(draft => {
      const nextOpen = typeof open === 'function' ? open(draft.isNewIssueOpen) : open;
      if (draft.isNewIssueOpen !== nextOpen) {
        draft.isNewIssueOpen = nextOpen;
      }
      if (!nextOpen) {
        draft.newIssueSource = null;
      }
    });
  }, [updateAppState]);

  const setFocusFilter = useCallback((value) => {
    updateAppState(draft => {
      if (draft.focusFilter !== value) {
        draft.focusFilter = value;
      }
    });
  }, [updateAppState]);

  const setFilterProject = useCallback((value) => {
    updateAppState(draft => {
      if (draft.filterProject !== value) {
        draft.filterProject = value;
      }
    });
  }, [updateAppState]);

  const setTheme = useCallback((nextTheme) => {
    updateAppState(draft => {
      const resolved = typeof nextTheme === 'function' ? nextTheme(draft.theme) : nextTheme;
      if (draft.theme !== resolved) {
        draft.theme = resolved;
      }
    });
  }, [updateAppState]);

  const toggleSidebar = useCallback(() => {
    updateAppState(draft => {
      const nextCollapsed = !draft.sidebarCollapsed;
      draft.sidebarCollapsed = nextCollapsed;
      localStorage.setItem('codex-sidebar-collapsed', String(nextCollapsed));
    });
  }, [updateAppState]);

  const navigateTo = useCallback((page, issueId = null, sessionId = '', handoffId = '') => {
    const resolvedPage = resolveRunsPage(resolveWorkBoardPage(page));
    const hashRoute = handoffRouteFromHash(globalThis.location?.hash);
    const targetHandoffId = resolvedPage === 'handoffs' ? handoffId || hashRoute?.handoffId || '' : '';
    if (resolvedPage !== 'handoffs' && hashRoute && globalThis.history && globalThis.location) {
      globalThis.history.replaceState(null, '', `${globalThis.location.pathname}${globalThis.location.search}`);
    }
    updateAppState(draft => {
      if (draft.currentPage !== resolvedPage) {
        draft.currentPage = resolvedPage;
      }
      if (draft.selectedIssueId !== issueId) {
        draft.selectedIssueId = issueId;
      }
      if (resolvedPage === 'runs') {
        const compatSessionRoute = page === 'sessions';
        draft.selectedRunId = compatSessionRoute ? '' : sessionId || '';
        draft.selectedSessionId = compatSessionRoute ? sessionId || '' : '';
      }
      draft.selectedHandoffId = targetHandoffId;
    });
  }, [updateAppState]);

  useEffect(() => {
    if (!globalThis.addEventListener) return undefined;
    const syncHandoffHash = () => {
      const route = handoffRouteFromHash(globalThis.location?.hash);
      if (!route) return;
      updateAppState(draft => {
        draft.currentPage = route.page;
        draft.selectedHandoffId = route.handoffId;
        draft.selectedIssueId = null;
      });
    };
    globalThis.addEventListener('hashchange', syncHandoffHash);
    return () => globalThis.removeEventListener('hashchange', syncHandoffHash);
  }, [updateAppState]);

  const refreshVisibleData = useCallback(() => {
    const slices = getReconcileSlices(currentPage, selectedIssueId);
    if (slices.length === 0) return;
    refreshData(slices);
  }, [currentPage, refreshData, selectedIssueId]);

  useEffect(() => {
    if (!authReady) return undefined;
    refreshVisibleData();
    // SSE 是主通道；低频 reconcile 只兜底补偿断线期间错过的事件。
    const slices = getReconcileSlices(currentPage, selectedIssueId);
    if (slices.length === 0) return undefined;

    const interval = setInterval(refreshVisibleData, RECONCILE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [authReady, currentPage, refreshVisibleData, selectedIssueId]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('codex-theme', theme);
  }, [theme]);



  // 订阅 SSE 实时变更，触发数据刷新
  useEffect(() => {
    if (!authReady) return undefined;
    const unsubscribe = eventsApi.subscribeToEvents(
      (event) => {
        if (ACTIVE_RECONCILE_EVENT_TYPES.has(event.type)) {
          refreshVisibleData();
        }
      },
      () => setBackendOnline(false),
      () => setBackendOnline(true)
    );
    return () => unsubscribe();
  }, [authReady, refreshVisibleData, setBackendOnline]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };

  const handleOpenNewIssue = (status = 'triage', source = null) => {
    updateAppState(draft => {
      draft.prefilledStatus = status;
      draft.newIssueSource = source || null;
      draft.isNewIssueOpen = true;
      draft.currentPage = 'issues';
      draft.selectedIssueId = null;
    });
  };

  const assistantModule = assistantModuleForPage(currentPage);


  if (!authReady) {
    return (
      <>
        <ToastContainer />
        <AuthGate onUnlock={setAuthReady} />
      </>
    );
  }

  return (
    <div className={`app-container ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${currentPage === 'runs' || currentPage === 'pi-chat' ? 'in-sessions-page' : ''}`}>
      <ToastContainer />
      {sidebarCollapsed && (
        <button
          className="sidebar-expand-btn animate-fade-in"
          onClick={toggleSidebar}
          title="展开菜单"
        >
          <Menu size={18} />
        </button>
      )}

      <AppSidebar
        currentPage={currentPage}
        filterProject={filterProject}
        focusFilter={focusFilter}
        handleOpenNewIssue={handleOpenNewIssue}
        navigateTo={navigateTo}
        setFilterProject={setFilterProject}
        setFocusFilter={setFocusFilter}
        theme={theme}
        toggleTheme={toggleTheme}
        toggleSidebar={toggleSidebar}
      />

      {/* 右侧主工作区 */}
      <main className="main-content">
        <GuardianAlertBanner />
        {loading ? (
          <div className="app-loading-stage">
            <TurtleLoader label="玄武正在唤醒工作台…" />
          </div>
        ) : (
          <Suspense fallback={<PageLoadingFallback />}>
            {currentPage === 'work' ? (
              <WorkBoard navigateTo={navigateTo} />
            ) : currentPage === 'handoffs' ? (
              <Handoffs selectedHandoffId={selectedHandoffId} />
            ) : currentPage === 'issues' && selectedIssueId ? (
              <IssueDetail issueId={selectedIssueId} navigateTo={navigateTo} />
            ) : currentPage === 'issues' ? (
              <Issues
                filterProject={filterProject}
                focusFilter={focusFilter}
                isNewIssueOpen={isNewIssueOpen}
                setIsNewIssueOpen={setIsNewIssueOpen}
                prefilledStatus={prefilledStatus}
                sourceMetadata={newIssueSource}
                handleOpenNewIssue={handleOpenNewIssue}
                navigateTo={navigateTo}
              />
            ) : currentPage === 'runs' ? (
              <Runs
                navigateTo={navigateTo}
                selectedRunId={selectedRunId}
                selectedSessionId={selectedSessionId}
              />
            ) : currentPage === 'pi-chat' ? (
              <PiChat navigateTo={navigateTo} />
            ) : currentPage === 'attention-inbox' || currentPage === 'pi-inbox' ? (
              <AttentionInbox />
            ) : isAssistantModulePage(currentPage) ? (
              <Settings initialTab={assistantModule?.tab} navigateTo={navigateTo} />
            ) : currentPage === 'projects' ? (
              <Projects />
            ) : currentPage === 'cron' ? (
              <Cron />
            ) : currentPage === 'settings' ? (
              <Settings navigateTo={navigateTo} />
            ) : (
              <Dashboard navigateTo={navigateTo} />
            )}
          </Suspense>
        )}
      </main>
    </div>
  );
}
