import { useCallback, useEffect } from 'react';
import { useImmer } from 'use-immer';
import { api } from './api/client';
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
  selectRefreshAllData,
  selectSetBackendOnline,
  useDataStore,
} from './store/dataStore';
import { RECONCILE_INTERVAL_MS } from './utils/stateGuards';
import { Loader2, Menu } from 'lucide-react';

export default function App() {
  const [appState, updateAppState] = useImmer(() => ({
    // 路由与过滤状态
    currentPage: 'issues', // 默认进入 Issues 看板以响应用户偏好
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
  }));

  const loading = useDataStore(selectLoading);
  const refreshAllData = useDataStore(selectRefreshAllData);
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
  } = appState;

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

  useEffect(() => {
    refreshAllData();
    // SSE 是主通道；低频 reconcile 只兜底补偿断线期间错过的事件。
    const interval = setInterval(refreshAllData, RECONCILE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refreshAllData]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('codex-theme', theme);
  }, [theme]);

  // 订阅 SSE 实时变更，触发数据刷新
  useEffect(() => {
    const unsubscribe = api.subscribeToEvents(
      (event) => {
        if (
          event.type === 'issue.created' ||
          event.type === 'issue.status_changed' ||
          event.type === 'issue.error' ||
          event.type === 'runner.started' ||
          event.type === 'runner.stopped' ||
          event.type === 'cron_task.ran' ||
          event.type === 'cron_task.error'
        ) {
          refreshAllData();
        }
      },
      () => setBackendOnline(false),
      () => setBackendOnline(true)
    );
    return () => unsubscribe();
  }, [refreshAllData, setBackendOnline]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };

  const handleOpenNewIssue = (status = 'triage') => {
    setPrefilledStatus(status);
    setIsNewIssueOpen(true);
  };

  return (
    <div className={`app-container ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
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
          ) : currentPage === 'projects' ? (
            <Projects />
          ) : currentPage === 'sessions' ? (
            <Sessions />
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
