
import { useCallback, useEffect } from 'react';
import { useImmer } from 'use-immer';
import { systemApi } from './api/system.js';

import { getAuthToken } from './api/authToken';
import { compatibilityApi } from './api/compatibility.js';
import { resolveProductPage } from './pages/assistantModules';

import { message as toast } from './store/toastStore';

import { workIdFromIssueId } from './pages/workBoardModel.js';
import { appHashForRoute, appRouteFromHash } from './appRouteModel.js';


export function useAppNavigation({ startPageTransition, setMobileSidebarOpen }) {
  const initialRoute = appRouteFromHash(globalThis.location?.hash);
  const [appState, updateAppState] = useImmer(() => ({
    // 路由与过滤状态
    ...initialRoute,
    pageContext: null,

    // 主题状态（默认 E2B 极客暗黑主题，支持一键切换）
    theme: localStorage.getItem('codex-theme') || 'dark',

    // 侧边栏折叠状态
    sidebarCollapsed: localStorage.getItem('codex-sidebar-collapsed') === 'true',

    // 远程访问 token 第一阶段：本地保存后才发起 API 请求
    authReady: Boolean(getAuthToken()),
  }));
  const {
    currentPage,
    selectedWorkId,
    selectedRunId,
    selectedPiConversationId,
    taskScope,
    taskSource,
    filterProject,
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

  const setFilterProject = useCallback((value) => {
    updateAppState(draft => {
      if (draft.filterProject !== value) {
        draft.filterProject = value;
      }
    });
    if (currentPage === 'tasks') {
      writeBrowserRoute({
        currentPage,
        filterProject: value,
        selectedWorkId,
        selectedRunId,
        taskScope,
        taskSource,
      }, { replace: true });
    }
  }, [currentPage, selectedWorkId, selectedRunId, taskScope, taskSource, updateAppState, writeBrowserRoute]);

  const setTaskSource = useCallback((value) => {
    updateAppState(draft => { draft.taskSource = value; });
    writeBrowserRoute({ currentPage: 'tasks', filterProject, taskScope, taskSource: value });
  }, [filterProject, taskScope, updateAppState, writeBrowserRoute]);

  const setTaskScope = useCallback((value) => {
    updateAppState(draft => { draft.taskScope = value; });
    writeBrowserRoute({ currentPage: 'tasks', filterProject, taskScope: value, taskSource });
  }, [filterProject, taskSource, updateAppState, writeBrowserRoute]);

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

  const navigateTo = useCallback((page, entityId = null, sessionId = '', handoffId = '', navigationOptions = {}) => {
    const resolvedPage = resolveProductPage(page);
    const internalProviderSessionId = String(navigationOptions?.sessionId || '').trim();
    const suppressLegacyWarning = navigationOptions?.suppressLegacyWarning === true;
    if ((page === 'issues' || page === 'sessions') && resolvedPage !== page && !suppressLegacyWarning) {
      compatibilityApi.recordLegacyRoute({ family: page, target: resolvedPage }).catch(() => {});
      toast.warning(
        `${page === 'issues' ? 'Issues' : 'Sessions'} 旧入口已迁移到 ${resolvedPage === 'tasks' ? 'Work' : 'Runs'}；compat v1 保留至 v0.3.x。`,
        6000,
      );
    }
    const targetHandoffId = resolvedPage === 'handoffs' || resolvedPage === 'tasks' ? handoffId || '' : '';
    const targetWorkId = resolvedPage === 'tasks'
      ? page === 'issues' ? workIdFromIssueId(entityId) : String(entityId || '')
      : '';
    const compatSessionRoute = resolvedPage === 'runs' && (page === 'sessions' || Boolean(internalProviderSessionId));
    const targetRunId = resolvedPage === 'runs' && !compatSessionRoute
      ? sessionId || ''
      : resolvedPage === 'tasks' && targetWorkId ? String(navigationOptions?.runId || '').trim() : '';
    const targetSessionId = resolvedPage === 'runs' && compatSessionRoute
      ? internalProviderSessionId || sessionId || ''
      : '';
    const targetSettingsSection = resolvedPage === 'settings'
      ? String(navigationOptions?.settingsSection || 'general').trim()
      : '';
    const targetRoute = {
      currentPage: resolvedPage,
      filterProject: String(navigationOptions?.project || '').trim(),
      selectedHandoffId: targetHandoffId,
      selectedPiConversationId: resolvedPage === 'ask-xuanwu' ? selectedPiConversationId : '',
      selectedRunId: targetRunId,
      selectedSessionId: targetSessionId,
      selectedWorkId: targetWorkId,
      settingsSection: targetSettingsSection,
      taskSource: resolvedPage === 'tasks' ? String(navigationOptions?.source || '') : '',
      taskScope: resolvedPage === 'tasks' && !targetWorkId ? String(navigationOptions?.scope || '') : '',
    };
    startPageTransition(() => updateAppState(draft => {
      if (draft.currentPage !== resolvedPage) {
        draft.currentPage = resolvedPage;
      }
      if (draft.selectedWorkId !== targetWorkId) {
        draft.selectedWorkId = targetWorkId;
      }
      if (resolvedPage === 'runs') {
        draft.selectedRunId = targetRunId;
        draft.selectedSessionId = targetSessionId;
      }
      if (resolvedPage === 'tasks') {
        draft.selectedRunId = targetRunId;
        draft.taskScope = targetRoute.taskScope;
        draft.taskSource = targetRoute.taskSource;
      }
      draft.filterProject = targetRoute.filterProject;
      draft.settingsSection = targetSettingsSection;
      draft.selectedHandoffId = targetHandoffId;
      draft.pageContext = null;
    }));
    setMobileSidebarOpen(false);
    writeBrowserRoute(targetRoute);
  }, [selectedPiConversationId, setMobileSidebarOpen, startPageTransition, updateAppState, writeBrowserRoute]);

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
    startPageTransition(() => updateAppState(draft => {
      draft.selectedPiConversationId = targetConversationId;
      draft.currentPage = 'ask-xuanwu';
      draft.selectedWorkId = '';
      draft.pageContext = null;
    }));
    writeBrowserRoute({
      currentPage: 'ask-xuanwu',
      selectedPiConversationId: targetConversationId,
    });
  }, [startPageTransition, updateAppState, writeBrowserRoute]);

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
  }, [setMobileSidebarOpen, updateAppState, writeBrowserRoute]);

  useEffect(() => {
    if (!globalThis.addEventListener) return undefined;
    const syncBrowserRoute = () => {
      const route = appRouteFromHash(globalThis.location?.hash);
      startPageTransition(() => updateAppState(draft => {
        draft.currentPage = route.currentPage;
        draft.filterProject = route.filterProject;
        draft.selectedHandoffId = route.selectedHandoffId;
        draft.selectedPiConversationId = route.selectedPiConversationId;
        draft.selectedRunId = route.selectedRunId;
        draft.selectedSessionId = route.selectedSessionId;
        draft.settingsSection = route.settingsSection;
        draft.selectedWorkId = route.selectedWorkId;
        draft.taskScope = route.taskScope;
        draft.taskSource = route.taskSource;
        draft.pageContext = null;
      }));
      setMobileSidebarOpen(false);
    };
    globalThis.addEventListener('hashchange', syncBrowserRoute);
    globalThis.addEventListener('popstate', syncBrowserRoute);
    return () => {
      globalThis.removeEventListener('hashchange', syncBrowserRoute);
      globalThis.removeEventListener('popstate', syncBrowserRoute);
    };
  }, [setMobileSidebarOpen, startPageTransition, updateAppState]);

  return { appState, setAuthReady, writeBrowserRoute, setFilterProject, setTaskSource, setTaskScope,
    setTheme, toggleSidebar, navigateTo, navigateToSettingsSection, setPageContext,
    openSupervisorConversation, rememberPiConversation };
}
