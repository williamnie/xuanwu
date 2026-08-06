import {
  PI_ASSISTANT_MODULES,
  PRODUCT_COMPAT_ROUTE_REDIRECTS,
  PRODUCT_NAV_ITEMS,
  resolveProductPage,
} from './pages/assistantModules.js';
import { handoffHref, handoffRouteFromHash } from './pages/handoffPageModel.js';

const FOCUS_FILTERS = new Set(['all', 'triage', 'active', 'failed', 'archive']);
const ROUTABLE_PAGES = new Set([
  ...PRODUCT_NAV_ITEMS.map((item) => item.page),
  ...PI_ASSISTANT_MODULES.map((item) => item.page),
  ...Object.keys(PRODUCT_COMPAT_ROUTE_REDIRECTS),
  ...Object.values(PRODUCT_COMPAT_ROUTE_REDIRECTS),
  'handoffs',
  'issues',
]);

export const DEFAULT_APP_ROUTE = Object.freeze({
  currentPage: 'command-center',
  filterProject: '',
  focusFilter: 'all',
  selectedHandoffId: '',
  selectedIssueId: null,
  selectedPiConversationId: '',
  selectedRunId: '',
  selectedSessionId: '',
  selectedWorkId: '',
  settingsSection: '',
});

export function appRouteFromHash(hash, { workBoardEnabled = true } = {}) {
  const handoffRoute = handoffRouteFromHash(hash);
  if (handoffRoute) {
    return {
      ...DEFAULT_APP_ROUTE,
      currentPage: handoffRoute.page,
      selectedHandoffId: handoffRoute.handoffId,
      selectedWorkId: handoffRoute.workId || '',
    };
  }

  const rawHash = String(hash || '').replace(/^#\/?/, '');
  if (!rawHash) return { ...DEFAULT_APP_ROUTE };

  const [rawPath, rawQuery = ''] = rawHash.split('?', 2);
  const pathParts = rawPath.split('/');
  if (pathParts.length > 2) return { ...DEFAULT_APP_ROUTE };
  const [encodedPage, encodedEntity = ''] = pathParts;
  const requestedPage = decodeRouteValue(encodedPage);
  const pathEntity = decodeRouteValue(encodedEntity);
  if (!requestedPage || !ROUTABLE_PAGES.has(requestedPage)) {
    return { ...DEFAULT_APP_ROUTE };
  }

  const currentPage = resolveProductPage(requestedPage, { workBoardEnabled });
  const params = new URLSearchParams(rawQuery);
  const route = {
    ...DEFAULT_APP_ROUTE,
    currentPage,
  };

  if (currentPage === 'work') {
    route.selectedWorkId = pathEntity || routeParam(params, 'workId');
    if (requestedPage === 'issues' && !route.selectedWorkId) {
      route.selectedWorkId = workIdFromIssueParam(params);
    }
  }
  if (currentPage === 'issues') {
    route.selectedIssueId = requestedPage === 'work'
      ? issueIdFromWorkRoute(pathEntity || routeParam(params, 'workId'))
      : positiveIntegerParam(params, 'issueId');
    route.filterProject = routeParam(params, 'project');
    route.focusFilter = focusFilterParam(params);
  }
  if (currentPage === 'runs') {
    route.selectedRunId = routeParam(params, 'runId');
    route.selectedSessionId = route.selectedRunId ? '' : routeParam(params, 'sessionId');
  }
  if (currentPage === 'ask-xuanwu') {
    route.selectedPiConversationId = routeParam(params, 'conversationId');
  }
  if (currentPage === 'settings') {
    route.settingsSection = routeParam(params, 'section');
  }

  return route;
}

export function appHashForRoute(route) {
  const page = ROUTABLE_PAGES.has(route?.currentPage) ? route.currentPage : DEFAULT_APP_ROUTE.currentPage;
  const handoffId = cleanRouteValue(route?.selectedHandoffId);
  const workId = cleanRouteValue(route?.selectedWorkId);

  if (handoffId && (page === 'handoffs' || page === 'work')) {
    return handoffHref(handoffId, page === 'work' ? workId : '');
  }

  const params = new URLSearchParams();
  if (page === 'work' && workId) params.set('workId', workId);
  if (page === 'issues') {
    if (positiveInteger(route?.selectedIssueId)) params.set('issueId', String(route.selectedIssueId));
    const project = cleanRouteValue(route?.filterProject);
    const focus = FOCUS_FILTERS.has(route?.focusFilter) ? route.focusFilter : 'all';
    if (project) params.set('project', project);
    if (focus !== 'all') params.set('focus', focus);
  }
  if (page === 'runs') {
    const runId = cleanRouteValue(route?.selectedRunId);
    const sessionId = cleanRouteValue(route?.selectedSessionId);
    if (runId) params.set('runId', runId);
    else if (sessionId) params.set('sessionId', sessionId);
  }
  if (page === 'ask-xuanwu') {
    const conversationId = cleanRouteValue(route?.selectedPiConversationId);
    if (conversationId) params.set('conversationId', conversationId);
  }
  if (page === 'settings') {
    const section = cleanRouteValue(route?.settingsSection);
    if (section) params.set('section', section);
  }

  const query = params.toString();
  return `#/${encodeURIComponent(page)}${query ? `?${query}` : ''}`;
}

function cleanRouteValue(value) {
  return String(value || '').trim();
}

function decodeRouteValue(value) {
  try {
    return decodeURIComponent(String(value || '')).trim();
  } catch {
    return '';
  }
}

function routeParam(params, name) {
  return cleanRouteValue(params.get(name));
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function positiveIntegerParam(params, name) {
  return positiveInteger(routeParam(params, name));
}

function workIdFromIssueParam(params) {
  const issueId = positiveIntegerParam(params, 'issueId');
  return issueId ? `xw:work:issues:${issueId}` : '';
}

function issueIdFromWorkRoute(workId) {
  const match = /^xw:work:issues:([1-9]\d*)$/.exec(cleanRouteValue(workId));
  return match ? positiveInteger(match[1]) : null;
}

function focusFilterParam(params) {
  const value = routeParam(params, 'focus');
  return FOCUS_FILTERS.has(value) ? value : 'all';
}
