import { useAppNavigation } from './useAppNavigation.js';
import { useMobileSidebar } from './useMobileSidebar.js';
import { useAppReconciliation } from './useAppReconciliation.js';

import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, useTransition } from 'react';

import { assistantModuleForPage, isAssistantModulePage, productNavPageForRoute } from './pages/assistantModules';
import AppSidebar from './components/AppSidebar';
import GuardianAlertBanner from './components/GuardianAlertBanner';
import ReleaseUpdateDialog from './components/ReleaseUpdateDialog';
import TurtleLoader from './components/TurtleLoader';
import { selectBackendOnline, selectLoading, selectProjects, selectWorkSummary, useDataStore } from './store/dataStore';

import { isFirstDeliveryDetailRoute, readFirstRunOnboardingState, resolveFirstRunOnboarding, writeFirstRunOnboardingState } from './utils/firstRunOnboarding.js';
import { assistantApi } from './api/assistant.js';
import { createFirstDeliveryConnectionCheck } from './pages/command-center/firstDeliverySetup.js';
import { Menu } from 'lucide-react';
import ToastContainer from './components/ToastContainer';

import AuthGate from './components/AuthGate';

import { watchCanonicalAppHash } from './appRouteCanonicalization.js';
import './App.css';
import './GeekWorkbench.css';
import './GeekWorkbenchPages.css';
import './components/Metadata.css';
import { useI18n } from './i18n/context.js';

// 页面仅在用户实际访问时下载，避免 Dashboard 首屏载入编辑器和会话历史等重型依赖。
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Analytics = lazy(() => import('./pages/Analytics'));
const WorkBoard = lazy(() => import('./pages/WorkBoard'));
const TaskSubviewTabs = lazy(() => import('./pages/work/TaskSubviewTabs.jsx'));
const Runs = lazy(() => import('./pages/Runs'));
const Handoffs = lazy(() => import('./pages/Handoffs'));
const PiChat = lazy(() => import('./pages/PiChat'));
const GlobalAskComposer = lazy(() => import('./components/GlobalAskComposer'));
const Automations = lazy(() => import('./pages/Automations'));
const Settings = lazy(() => import('./pages/Settings'));
const OnboardingPage = lazy(() => import('./pages/OnboardingPage.jsx'));

const MOBILE_PAGE_TITLE_KEYS = {
  'ask-xuanwu': 'nav.askXuanwu',
  automations: 'nav.automations',
  'inbox': 'nav.commandCenter',
  analytics: 'nav.analytics',
  runs: 'nav.runs',
  settings: 'nav.settings',
  tasks: 'nav.work',
};

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
  const [pagePending, startPageTransition] = useTransition();
  const mainContentRef = useRef(null);
  const { isMobileViewport, mobileSidebarOpen, setMobileSidebarOpen, mobileMenuButtonRef, sidebarRef, closeMobileSidebar, openMobileSidebar } = useMobileSidebar();
  const { appState, setAuthReady, writeBrowserRoute, setFilterProject, setTaskSource, setTaskScope,
    setTheme, toggleSidebar, navigateTo, navigateToSettingsSection, setPageContext,
    openSupervisorConversation, rememberPiConversation } = useAppNavigation({ startPageTransition, setMobileSidebarOpen });
  const [firstRunOnboarding, setFirstRunOnboarding] = useState(() => readFirstRunOnboardingState() || 'pending');
  const [firstDeliveryWorkId, setFirstDeliveryWorkId] = useState('');
  const [checkFirstDeliveryConnection] = useState(() => createFirstDeliveryConnectionCheck(assistantApi));
  useLayoutEffect(() => watchCanonicalAppHash(), []);

  const backendOnline = useDataStore(selectBackendOnline);
  const loading = useDataStore(selectLoading);
  const projects = useDataStore(selectProjects);
  const workSummary = useDataStore(selectWorkSummary);

  useAppReconciliation({ authReady: appState.authReady, currentPage: appState.currentPage });

  const {
    currentPage,
    selectedWorkId,
    selectedRunId,
    selectedSessionId,
    selectedHandoffId,
    selectedPiConversationId,
    settingsSection,
    taskScope,
    taskSource,
    pageContext,
    filterProject,
    theme,
    sidebarCollapsed,
    authReady,
  } = appState;

  // 目标页面提交后回到页首，避免继承上一页的长内容滚动位置。
  useLayoutEffect(() => {
    if (mainContentRef.current) mainContentRef.current.scrollTop = 0;
  }, [currentPage]);

  useEffect(() => {
    if (!authReady || loading || !backendOnline || firstRunOnboarding !== 'pending') return;
    const next = resolveFirstRunOnboarding('', workSummary.counts.total);
    writeFirstRunOnboardingState(next === 'active' ? 'active' : 'completed');
    setFirstRunOnboarding(next);
  }, [authReady, backendOnline, firstRunOnboarding, loading, workSummary.counts.total]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('codex-theme', theme);
  }, [theme]);

  useEffect(() => {
    if (!authReady) return;
    refreshLanguage().catch(() => {});
  }, [authReady, refreshLanguage]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };

  const completeFirstRunOnboarding = () => {
    writeFirstRunOnboardingState('completed');
    setFirstRunOnboarding('hidden');
    navigateTo('inbox');
  };

  const skipFirstRunOnboarding = () => {
    writeFirstRunOnboardingState('dismissed');
    setFirstRunOnboarding('hidden');
    navigateTo('inbox');
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

  const firstDeliveryDetailOpen = firstRunOnboarding === 'active'
    && isFirstDeliveryDetailRoute(currentPage, selectedWorkId, firstDeliveryWorkId);
  const shouldShowOnboarding = !firstDeliveryDetailOpen && (firstRunOnboarding === 'active'
    || (firstRunOnboarding === 'pending' && !loading && backendOnline && workSummary.counts.total === 0));
  if (shouldShowOnboarding) {
    return (
      <>
        <ToastContainer />
        <Suspense fallback={<PageLoadingFallback />}>
          <OnboardingPage
            checkSavedConnection={checkFirstDeliveryConnection}
            onOpenWork={workId => {
              setFirstDeliveryWorkId(workId);
              // Make browser Back return to the guide, even if setup started on a deep link.
              writeBrowserRoute({ currentPage: 'inbox' }, { replace: true });
              navigateTo('tasks', workId);
            }}
            onComplete={completeFirstRunOnboarding}
            onSkip={skipFirstRunOnboarding}
            projects={projects}
            theme={theme}
            toggleTheme={toggleTheme}
          />
        </Suspense>
      </>
    );
  }

  return (
    <div className={`app-container ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${mobileSidebarOpen ? 'mobile-sidebar-open' : ''} ${currentPage === 'runs' || currentPage === 'ask-xuanwu' ? 'in-sessions-page' : ''} ${currentPage === 'runs' ? 'runs-page' : ''} ${currentPage === 'ask-xuanwu' ? 'ask-xuanwu-page' : ''}`}>
      <ToastContainer />
      <ReleaseUpdateDialog onOpenSettings={() => navigateTo('settings', null, '', '', { settingsSection: 'preferences' })} />
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
          <Menu aria-hidden="true" size={16} />
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
          <Menu size={16} />
        </button>
      )}

      <AppSidebar
        currentPage={currentPage}
        navigateTo={navigateTo}
        theme={theme}
        toggleTheme={toggleTheme}
        toggleSidebar={toggleSidebar}
        isMobileViewport={isMobileViewport}
        mobileSidebarOpen={mobileSidebarOpen}
        onMobileClose={closeMobileSidebar}
        sidebarRef={sidebarRef}
      />

      {/* 右侧主工作区 */}
      <main className="main-content" ref={mainContentRef} aria-busy={pagePending} inert={isMobileViewport && mobileSidebarOpen ? true : undefined}>
        {firstDeliveryDetailOpen ? <div className="first-delivery-return"><button className="btn btn-secondary" onClick={() => navigateTo('inbox')} type="button">返回引导</button><span>查看首次任务进度后，返回引导确认交付结果。</span></div> : null}
        {pagePending ? <span className="page-navigation-status" role="status">正在打开页面…</span> : null}
        <GuardianAlertBanner />
        {loading ? (
          <div className="app-loading-stage">
            <TurtleLoader label={t('app.wakingWorkbench')} />
          </div>
        ) : (
          <Suspense fallback={<PageLoadingFallback />}>
            {currentPage === 'inbox' ? (
              <Dashboard navigateTo={navigateTo} />
            ) : currentPage === 'analytics' ? (
              <Analytics />
            ) : currentPage === 'tasks' ? (
              <WorkBoard
                filterProject={filterProject}
                onProjectChange={setFilterProject}
                navigateTo={navigateTo}
                onPageContextChange={setPageContext}
                selectedHandoffId={selectedHandoffId}
                selectedRunId={selectedRunId}
                selectedWorkId={selectedWorkId}
                taskScope={taskScope}
                taskSource={taskSource}
                onSourceChange={setTaskSource}
                onScopeChange={setTaskScope}
              />
            ) : currentPage === 'handoffs' ? (
              <Handoffs selectedHandoffId={selectedHandoffId} />
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
              <div className="automations-subview-shell">
                <TaskSubviewTabs active="automations" navigateTo={navigateTo} />
                <Automations />
              </div>
            ) : currentPage === 'settings' ? (
              <Settings initialTab={settingsSection || 'general'} navigateTo={navigateTo} onSectionChange={navigateToSettingsSection} theme={theme} toggleTheme={toggleTheme} />
            ) : (
              <Dashboard navigateTo={navigateTo} />
            )}
          </Suspense>
        )}
      </main>
      <Suspense fallback={null}>
        <GlobalAskComposer
          currentPage={currentPage}
          onConversationReady={openSupervisorConversation}
          onOpenAskXuanwu={() => navigateTo('ask-xuanwu')}
          pageContext={pageContext}
          selectedHandoffId={selectedHandoffId}
          selectedRunId={selectedRunId}
          selectedSessionId={selectedSessionId}
        />
      </Suspense>
    </div>
  );
}
