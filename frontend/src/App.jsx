import { useCallback, useEffect } from 'react';
import { useImmer } from 'use-immer';
import { api } from './api/client';
import { getAuthToken } from './api/authToken';
import Dashboard from './pages/Dashboard';
import Projects from './pages/Projects';
import Issues from './pages/Issues';
import IssueDetail from './pages/IssueDetail';
import Sessions from './pages/Sessions';
import Cron from './pages/Cron';
import Settings from './pages/Settings';
import AppSidebar from './components/AppSidebar';
import {
  selectLoading,
  selectRefreshData,
  selectSetBackendOnline,
  useDataStore,
} from './store/dataStore';
import { RECONCILE_INTERVAL_MS } from './utils/stateGuards';
import { Loader2, Menu } from 'lucide-react';
import ToastContainer from './components/ToastContainer';
import AuthGate from './components/AuthGate';

const ACTIVE_RECONCILE_EVENT_TYPES = new Set([
  'issue.created',
  'issue.status_changed',
  'issue.error',
  'runner.started',
  'runner.stopped',
  'cron_task.ran',
  'cron_task.error',
]);

function getReconcileSlices(currentPage, selectedIssueId) {
  if (currentPage === 'issues') {
    return selectedIssueId
      ? ['projects', 'issues']
      : ['projects', 'issues', 'issueTemplates', 'cronTasks'];
  }
  if (currentPage === 'projects') {
    return ['projects', 'issues'];
  }
  if (currentPage === 'cron') {
    return ['projects', 'cronTasks'];
  }
  if (currentPage === 'dashboard') {
    return ['projects', 'issues'];
  }
  return [];
}

export default function App() {
  const [appState, updateAppState] = useImmer(() => ({
    // 路由与过滤状态
    currentPage: 'dashboard', // 默认进入 Dashboard
    selectedIssueId: null,
    filterProject: '', // '' 表示 Any project
    focusFilter: 'all', // 'all' | 'triage' | 'active' | 'failed' | 'archive'

    // 新增 Issue 弹窗的全局状态（可以从侧边栏 + 看板列头触发）
    isNewIssueOpen: false,
    prefilledStatus: 'triage',

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
    filterProject,
    focusFilter,
    isNewIssueOpen,
    prefilledStatus,
    theme,
    sidebarCollapsed,
    authReady,
  } = appState;

  const setAuthReady = useCallback(() => {
    updateAppState(draft => {
      draft.authReady = true;
    });
  }, [updateAppState]);

  const setIsNewIssueOpen = useCallback((open) => {
    updateAppState(draft => {
      const nextOpen = typeof open === 'function' ? open(draft.isNewIssueOpen) : open;
      if (draft.isNewIssueOpen !== nextOpen) {
        draft.isNewIssueOpen = nextOpen;
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

  const setPrefilledStatus = useCallback((status) => {
    updateAppState(draft => {
      if (draft.prefilledStatus !== status) {
        draft.prefilledStatus = status;
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

  const navigateTo = useCallback((page, issueId = null) => {
    updateAppState(draft => {
      if (draft.currentPage !== page) {
        draft.currentPage = page;
      }
      if (draft.selectedIssueId !== issueId) {
        draft.selectedIssueId = issueId;
      }
    });
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
    const unsubscribe = api.subscribeToEvents(
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

  const handleOpenNewIssue = (status = 'triage') => {
    setPrefilledStatus(status);
    setIsNewIssueOpen(true);
  };



  if (!authReady) {
    return (
      <>
        <ToastContainer />
        <AuthGate onUnlock={setAuthReady} />
      </>
    );
  }

  return (
    <div className={`app-container ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${currentPage === 'sessions' ? 'in-sessions-page' : ''}`}>
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
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: '16px' }}>
            <Loader2 className="animate-spin" size={32} color="var(--primary)" />
            <p style={{ color: 'var(--text-secondary)' }}>载入系统中...</p>
          </div>
        ) : (
          currentPage === 'issues' && selectedIssueId ? (
            <IssueDetail issueId={selectedIssueId} navigateTo={navigateTo} />
          ) : currentPage === 'issues' ? (
            <Issues
              filterProject={filterProject}
              focusFilter={focusFilter}
              isNewIssueOpen={isNewIssueOpen}
              setIsNewIssueOpen={setIsNewIssueOpen}
              prefilledStatus={prefilledStatus}
              handleOpenNewIssue={handleOpenNewIssue}
              navigateTo={navigateTo}
            />
          ) : currentPage === 'sessions' ? (
            <Sessions
              navigateTo={navigateTo}
              theme={theme}
              toggleTheme={toggleTheme}
            />
          ) : currentPage === 'projects' ? (
            <Projects />
          ) : currentPage === 'cron' ? (
            <Cron />
          ) : currentPage === 'settings' ? (
            <Settings />
          ) : (
            <Dashboard navigateTo={navigateTo} />
          )
        )}
      </main>
    </div>
  );
}
