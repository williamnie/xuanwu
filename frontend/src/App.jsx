import { eventsApi } from './api/events.js';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useImmer } from 'use-immer';
import { systemApi } from './api/system.js';
import { createBackendConnectionMonitor } from './api/backendConnectionMonitor.js';
import { getAuthToken } from './api/authToken';
import { compatibilityApi } from './api/compatibility.js';
import {
  assistantModuleForPage,
  isAssistantModulePage,
  productNavPageForRoute,
  resolveProductPage,
} from './pages/assistantModules';
import AppSidebar from './components/AppSidebar';
import GuardianAlertBanner from './components/GuardianAlertBanner';
import ReleaseUpdateDialog from './components/ReleaseUpdateDialog';
import TurtleLoader from './components/TurtleLoader';
import {
  selectLoading,
  selectRefreshData,
  selectSetBackendConnectionState,
  useDataStore,
} from './store/dataStore';
import { RECONCILE_INTERVAL_MS } from './utils/stateGuards';
import { Menu } from 'lucide-react';
import ToastContainer from './components/ToastContainer';
import { message as toast } from './store/toastStore';
import AuthGate from './components/AuthGate';
import { issueIdFromWorkId, workIdFromIssueId, WORK_BOARD_ENABLED } from './pages/workBoardModel.js';
import { appHashForRoute, appRouteFromHash } from './appRouteModel.js';
import './App.css';
import './GeekWorkbench.css';
import './GeekWorkbenchPages.css';
import { useI18n } from './i18n/context.js';

// 页面仅在用户实际访问时下载，避免 Dashboard 首屏载入编辑器和会话历史等重型依赖。
const Dashboard = lazy(() => import('./pages/Dashboard'));
const WorkBoard = lazy(() => import('./pages/WorkBoard'));
const Issues = lazy(() => import('./pages/Issues'));
const IssueDetail = lazy(() => import('./pages/IssueDetail'));
const Runs = lazy(() => import('./pages/Runs'));
const Handoffs = lazy(() => import('./pages/Handoffs'));
const PiChat = lazy(() => import('./pages/PiChat'));
const GlobalAskComposer = lazy(() => import('./components/GlobalAskComposer'));
const Automations = lazy(() => import('./pages/Automations'));
const Settings = lazy(() => import('./pages/Settings'));

const WORK_SUMMARY_RECONCILE_EVENT_TYPES = new Set([
  'issue.created',
  'issue.deleted',
  'issue.status_changed',
  'issue.updated',
]);

const PROJECT_RECONCILE_EVENT_TYPES = new Set([
  'runner.started',
  'runner.stopped',
  'runner.hold',
  'runner.hold_active',
  'runner.hold_check.failed',
  'runner.hold_cleared',
]);

const PAGE_DATA_SLICES = {
  automations: ['projects'],
  'command-center': ['projects', 'workSummary'],
  issues: ['projects', 'workSummary'],
  settings: ['projects', 'workSummary'],
  work: ['projects', 'workSummary'],
  handoffs: ['projects'],
};

const MOBILE_PAGE_TITLE_KEYS = {
  'ask-xuanwu': 'nav.askXuanwu',
  automations: 'nav.automations',
  'command-center': 'nav.commandCenter',
  runs: 'nav.runs',
  settings: 'nav.settings',
  work: 'nav.work',
};

function getReconcileSlices(currentPage, selectedIssueId) {
  // IssueDetail 自己读取单条 issue；不要在详情页额外轮询整张 issues 列表。
  if (currentPage === 'issues' && selectedIssueId) return [];
  return PAGE_DATA_SLICES[currentPage] || [];
}

function PageLoadingFallback() {
  const { t } = useI18n();
  return (
    <div className="app-loading-stage" role="status" aria-live="polite">
      <TurtleLoader label={t('app.loadingPage')} />
    </div>
  );
}

export default function App() {
  const { refreshLanguage, t } = useI18n();
  const [isMobileViewport, setIsMobileViewport] = useState(() => globalThis.matchMedia?.('(max-width: 760px)').matches || false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const mobileMenuButtonRef = useRef(null);
  const sidebarRef = useRef(null);
  const initialRoute = appRouteFromHash(globalThis.location?.hash, { workBoardEnabled: WORK_BOARD_ENABLED });
  const [appState, updateAppState] = useImmer(() => ({
    // 路由与过滤状态
    ...initialRoute,
    pageContext: null,

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
  const setBackendConnectionState = useDataStore(selectSetBackendConnectionState);

  const {
    currentPage,
    selectedIssueId,
    selectedWorkId,
    selectedRunId,
    selectedSessionId,
    selectedHandoffId,
    selectedPiConversationId,
    settingsSection,
    pageContext,
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

  const writeBrowserRoute = useCallback((route, { replace = false } = {}) => {
    if (!globalThis.history || !globalThis.location) return;
    const hash = appHashForRoute(route);
    if (globalThis.location.hash === hash) return;
    const href = `${globalThis.location.pathname}${globalThis.location.search}${hash}`;
    globalThis.history[replace ? 'replaceState' : 'pushState'](null, '', href);
  }, []);

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
    if (currentPage === 'issues') {
      writeBrowserRoute({
        currentPage,
        filterProject,
        focusFilter: value,
        selectedIssueId,
      }, { replace: true });
    }
  }, [currentPage, filterProject, selectedIssueId, updateAppState, writeBrowserRoute]);

  const setFilterProject = useCallback((value) => {
    updateAppState(draft => {
      if (draft.filterProject !== value) {
        draft.filterProject = value;
      }
    });
    if (currentPage === 'issues') {
      writeBrowserRoute({
        currentPage,
        filterProject: value,
        focusFilter,
        selectedIssueId,
      }, { replace: true });
    }
  }, [currentPage, focusFilter, selectedIssueId, updateAppState, writeBrowserRoute]);

  const setTheme = useCallback((nextTheme) => {
    updateAppState(draft => {
      const resolved = typeof nextTheme === 'function' ? nextTheme(draft.theme) : nextTheme;
      if (draft.theme !== resolved) {
        draft.theme = resolved;
      }
    });
  }, [updateAppState]);

  const closeMobileSidebar = useCallback(() => {
    setMobileSidebarOpen(false);
    globalThis.requestAnimationFrame?.(() => mobileMenuButtonRef.current?.focus());
  }, []);

  const openMobileSidebar = useCallback(() => {
    setMobileSidebarOpen(true);
  }, []);

  const toggleSidebar = useCallback(() => {
    updateAppState(draft => {
      const nextCollapsed = !draft.sidebarCollapsed;
      draft.sidebarCollapsed = nextCollapsed;
      localStorage.setItem('codex-sidebar-collapsed', String(nextCollapsed));
    });
  }, [updateAppState]);

  const navigateTo = useCallback((page, issueId = null, sessionId = '', handoffId = '', navigationOptions = {}) => {
    const resolvedPage = resolveProductPage(page, { workBoardEnabled: WORK_BOARD_ENABLED });
    const internalProviderSessionId = String(navigationOptions?.sessionId || '').trim();
    const suppressLegacyWarning = navigationOptions?.suppressLegacyWarning === true;
    if ((page === 'issues' || page === 'sessions') && resolvedPage !== page && !suppressLegacyWarning) {
      compatibilityApi.recordLegacyRoute({ family: page, target: resolvedPage }).catch(() => {});
      toast.warning(
        `${page === 'issues' ? 'Issues' : 'Sessions'} 旧入口已迁移到 ${resolvedPage === 'work' ? 'Work' : 'Runs'}；compat v1 保留至 v0.3.x。`,
        6000,
      );
    }
    const targetHandoffId = resolvedPage === 'handoffs' || resolvedPage === 'work' ? handoffId || '' : '';
    const targetIssueId = resolvedPage === 'issues'
      ? page === 'work' ? issueIdFromWorkId(issueId) : issueId
      : null;
    const targetWorkId = resolvedPage === 'work'
      ? page === 'issues' ? workIdFromIssueId(issueId) : String(issueId || '')
      : '';
    const compatSessionRoute = resolvedPage === 'runs' && (page === 'sessions' || Boolean(internalProviderSessionId));
    const targetRunId = resolvedPage === 'runs' && !compatSessionRoute ? sessionId || '' : '';
    const targetSessionId = resolvedPage === 'runs' && compatSessionRoute
      ? internalProviderSessionId || sessionId || ''
      : '';
    const targetSettingsSection = resolvedPage === 'settings'
      ? String(navigationOptions?.settingsSection || 'general').trim()
      : '';
    const targetRoute = {
      currentPage: resolvedPage,
      selectedHandoffId: targetHandoffId,
      selectedIssueId: targetIssueId,
      selectedPiConversationId: resolvedPage === 'ask-xuanwu' ? selectedPiConversationId : '',
      selectedRunId: targetRunId,
      selectedSessionId: targetSessionId,
      selectedWorkId: targetWorkId,
      settingsSection: targetSettingsSection,
    };
    updateAppState(draft => {
      if (draft.currentPage !== resolvedPage) {
        draft.currentPage = resolvedPage;
      }
      if (draft.selectedIssueId !== targetIssueId) {
        draft.selectedIssueId = targetIssueId;
      }
      if (draft.selectedWorkId !== targetWorkId) {
        draft.selectedWorkId = targetWorkId;
      }
      if (resolvedPage === 'runs') {
        draft.selectedRunId = targetRunId;
        draft.selectedSessionId = targetSessionId;
      }
      draft.settingsSection = targetSettingsSection;
      draft.selectedHandoffId = targetHandoffId;
      draft.pageContext = null;
    });
    setMobileSidebarOpen(false);
    writeBrowserRoute(targetRoute);
  }, [selectedPiConversationId, updateAppState, writeBrowserRoute]);

  const navigateToSettingsSection = useCallback((section) => {
    navigateTo('settings', null, '', '', { settingsSection: section });
  }, [navigateTo]);

  const setPageContext = useCallback((context) => {
    updateAppState(draft => {
      const next = context && context.page_id === draft.currentPage ? context : null;
      if (JSON.stringify(draft.pageContext) !== JSON.stringify(next)) {
        draft.pageContext = next;
      }
    });
  }, [updateAppState]);

  const openSupervisorConversation = useCallback((conversationId) => {
    const targetConversationId = conversationId || '';
    updateAppState(draft => {
      draft.selectedPiConversationId = targetConversationId;
      draft.currentPage = 'ask-xuanwu';
      draft.selectedIssueId = null;
      draft.selectedWorkId = '';
      draft.pageContext = null;
    });
    writeBrowserRoute({
      currentPage: 'ask-xuanwu',
      selectedPiConversationId: targetConversationId,
    });
  }, [updateAppState, writeBrowserRoute]);

  const rememberPiConversation = useCallback((conversationId) => {
    const targetConversationId = conversationId || '';
    updateAppState(draft => {
      draft.selectedPiConversationId = targetConversationId;
    });
    writeBrowserRoute({
      currentPage: 'ask-xuanwu',
      selectedPiConversationId: targetConversationId,
    }, { replace: true });
    setMobileSidebarOpen(false);
  }, [updateAppState, writeBrowserRoute]);

  useEffect(() => {
    if (!globalThis.addEventListener) return undefined;
    const syncBrowserRoute = () => {
      const route = appRouteFromHash(globalThis.location?.hash, { workBoardEnabled: WORK_BOARD_ENABLED });
      updateAppState(draft => {
        draft.currentPage = route.currentPage;
        draft.filterProject = route.filterProject;
        draft.focusFilter = route.focusFilter;
        draft.selectedHandoffId = route.selectedHandoffId;
        draft.selectedIssueId = route.selectedIssueId;
        draft.selectedPiConversationId = route.selectedPiConversationId;
        draft.selectedRunId = route.selectedRunId;
        draft.selectedSessionId = route.selectedSessionId;
        draft.settingsSection = route.settingsSection;
        draft.selectedWorkId = route.selectedWorkId;
        draft.pageContext = null;
      });
      setMobileSidebarOpen(false);
    };
    globalThis.addEventListener('hashchange', syncBrowserRoute);
    globalThis.addEventListener('popstate', syncBrowserRoute);
    return () => {
      globalThis.removeEventListener('hashchange', syncBrowserRoute);
      globalThis.removeEventListener('popstate', syncBrowserRoute);
    };
  }, [updateAppState]);

  useEffect(() => {
    if (!globalThis.matchMedia) return undefined;
    const mediaQuery = globalThis.matchMedia('(max-width: 760px)');
    const syncMobileViewport = (event) => {
      setIsMobileViewport(event.matches);
      if (!event.matches) setMobileSidebarOpen(false);
    };
    setIsMobileViewport(mediaQuery.matches);
    mediaQuery.addEventListener('change', syncMobileViewport);
    return () => mediaQuery.removeEventListener('change', syncMobileViewport);
  }, []);

  useEffect(() => {
    if (!isMobileViewport || !mobileSidebarOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    const focusableSelector = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusFrame = globalThis.requestAnimationFrame?.(() => {
      sidebarRef.current?.querySelector(focusableSelector)?.focus();
    });
    const handleDrawerKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMobileSidebar();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(sidebarRef.current?.querySelectorAll(focusableSelector) || []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleDrawerKeyDown);
    return () => {
      if (focusFrame) globalThis.cancelAnimationFrame?.(focusFrame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleDrawerKeyDown);
    };
  }, [closeMobileSidebar, isMobileViewport, mobileSidebarOpen]);

  const refreshVisibleData = useCallback(() => {
    refreshData(getReconcileSlices(currentPage, selectedIssueId));
  }, [currentPage, refreshData, selectedIssueId]);

  const refreshVisibleWorkSummary = useCallback(() => {
    const slices = getReconcileSlices(currentPage, selectedIssueId);
    if (slices.includes('workSummary')) refreshData(['workSummary']);
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

  useEffect(() => {
    if (!authReady) return;
    refreshLanguage().catch(() => {});
  }, [authReady, refreshLanguage]);



  // 订阅 SSE 实时变更，触发数据刷新
  useEffect(() => {
    if (!authReady) return undefined;
    const monitor = createBackendConnectionMonitor({
      onStateChange: setBackendConnectionState,
      probe: signal => systemApi.getCoreHealth({ signal }),
    });
    const unsubscribe = eventsApi.subscribeToEvents(
      (event) => {
        if (WORK_SUMMARY_RECONCILE_EVENT_TYPES.has(event.type)) {
          refreshVisibleWorkSummary();
        } else if (PROJECT_RECONCILE_EVENT_TYPES.has(event.type)) {
          refreshData(['projects']);
        }
      },
      () => monitor.onError(),
      () => monitor.onOpen()
    );
    return () => {
      monitor.stop();
      unsubscribe();
    };
  }, [authReady, refreshData, refreshVisibleWorkSummary, setBackendConnectionState]);

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
      draft.selectedWorkId = '';
    });
    writeBrowserRoute({ currentPage: 'issues' });
  };

  const assistantModule = assistantModuleForPage(currentPage);
  const mobileNavPage = productNavPageForRoute(currentPage);
  const mobilePageTitle = t(MOBILE_PAGE_TITLE_KEYS[mobileNavPage] || 'nav.commandCenter');


  if (!authReady) {
    return (
      <>
        <ToastContainer />
        <AuthGate onUnlock={setAuthReady} />
      </>
    );
  }

  return (
    <div className={`app-container ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${mobileSidebarOpen ? 'mobile-sidebar-open' : ''} ${currentPage === 'runs' || currentPage === 'ask-xuanwu' ? 'in-sessions-page' : ''} ${currentPage === 'runs' ? 'runs-page' : ''} ${currentPage === 'ask-xuanwu' ? 'ask-xuanwu-page' : ''}`}>
      <ToastContainer />
      <ReleaseUpdateDialog onOpenSettings={() => navigateTo('settings', null, '', '', { settingsSection: 'general' })} />
      <header className="mobile-app-header" inert={mobileSidebarOpen ? true : undefined}>
        <button
          aria-controls="app-sidebar"
          aria-expanded={mobileSidebarOpen}
          aria-label={t('sidebar.expand')}
          className="mobile-sidebar-menu-btn"
          onClick={openMobileSidebar}
          ref={mobileMenuButtonRef}
          type="button"
        >
          <Menu aria-hidden="true" size={18} />
        </button>
        <span className="mobile-app-header-title">{mobilePageTitle}</span>
        <span aria-hidden="true" className="mobile-app-header-spacer" />
      </header>
      {mobileSidebarOpen ? (
        <div
          aria-hidden="true"
          className="mobile-sidebar-backdrop"
          onClick={closeMobileSidebar}
        />
      ) : null}
      {sidebarCollapsed && (
        <button
          className="sidebar-expand-btn animate-fade-in"
          onClick={toggleSidebar}
          title={t('sidebar.expand')}
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
        isMobileViewport={isMobileViewport}
        mobileSidebarOpen={mobileSidebarOpen}
        onMobileClose={closeMobileSidebar}
        sidebarRef={sidebarRef}
      />

      {/* 右侧主工作区 */}
      <main className="main-content" inert={isMobileViewport && mobileSidebarOpen ? true : undefined}>
        <GuardianAlertBanner />
        {loading ? (
          <div className="app-loading-stage">
            <TurtleLoader label={t('app.wakingWorkbench')} />
          </div>
        ) : (
          <Suspense fallback={<PageLoadingFallback />}>
            {currentPage === 'command-center' ? (
              <Dashboard navigateTo={navigateTo} />
            ) : currentPage === 'work' ? (
              <WorkBoard
                navigateTo={navigateTo}
                onPageContextChange={setPageContext}
                selectedHandoffId={selectedHandoffId}
                selectedWorkId={selectedWorkId}
              />
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
                onMobileSidebarAction={isMobileViewport ? closeMobileSidebar : undefined}
                onPageContextChange={setPageContext}
                selectedRunId={selectedRunId}
                selectedSessionId={selectedSessionId}
              />
            ) : currentPage === 'ask-xuanwu' ? (
              <PiChat
                navigateTo={navigateTo}
                initialConversationId={selectedPiConversationId}
                onConversationChange={rememberPiConversation}
              />
            ) : isAssistantModulePage(currentPage) ? (
              <Settings initialTab={assistantModule?.tab} navigateTo={navigateTo} onSectionChange={navigateToSettingsSection} />
            ) : currentPage === 'automations' ? (
              <Automations />
            ) : currentPage === 'settings' ? (
              <Settings initialTab={settingsSection || 'general'} navigateTo={navigateTo} onSectionChange={navigateToSettingsSection} />
            ) : (
              <Dashboard navigateTo={navigateTo} />
            )}
          </Suspense>
        )}
      </main>
      <Suspense fallback={null}>
        <GlobalAskComposer
          currentPage={currentPage}
          filterProject={filterProject}
          onConversationReady={openSupervisorConversation}
          onOpenAskXuanwu={() => navigateTo('ask-xuanwu')}
          pageContext={pageContext}
          selectedHandoffId={selectedHandoffId}
          selectedIssueId={selectedIssueId}
          selectedRunId={selectedRunId}
          selectedSessionId={selectedSessionId}
        />
      </Suspense>
    </div>
  );
}
