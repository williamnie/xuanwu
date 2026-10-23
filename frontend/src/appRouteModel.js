import {
  PI_ASSISTANT_MODULES,
  PRODUCT_COMPAT_ROUTE_REDIRECTS,
  PRODUCT_NAV_ITEMS,
  PRODUCT_ROUTE_ALIASES,
  resolveProductPage,
} from './pages/assistantModules.js';
import { handoffHref, handoffRouteFromHash } from './pages/handoffPageModel.js';

const TASK_SOURCES = new Set(['github', 'manual']);
const TASK_SCOPES = new Set(['active', 'attention', 'done', 'all']);
const ROUTABLE_PAGES = new Set([
  ...PRODUCT_NAV_ITEMS.map((item) => item.page),
  ...PI_ASSISTANT_MODULES.map((item) => item.page),
  ...Object.keys(PRODUCT_COMPAT_ROUTE_REDIRECTS),
  ...Object.values(PRODUCT_COMPAT_ROUTE_REDIRECTS),
  'handoffs',
]);

export const DEFAULT_APP_ROUTE = Object.freeze({
  currentPage: 'inbox',
  filterProject: '',
  selectedHandoffId: '',
  selectedPiConversationId: '',
  selectedRunId: '',
  selectedSessionId: '',
  selectedWorkId: '',
  settingsSection: '',
  taskScope: '',
  taskSource: '',
});

export function appRouteFromHash(hash) {
  const handoffRoute = handoffRouteFromHash(hash);
  if (handoffRoute) {
    const queryIndex = String(hash).indexOf('?');
    const params = new URLSearchParams(queryIndex < 0 ? '' : String(hash).slice(queryIndex + 1));
    const taskContext = handoffRoute.page === 'tasks' ? {
      filterProject: routeParam(params, 'project'),
      taskSource: TASK_SOURCES.has(routeParam(params, 'source')) ? routeParam(params, 'source') : '',
      selectedRunId: routeParam(params, 'runId'),
    } : {};
    return {
      ...DEFAULT_APP_ROUTE,
      ...taskContext,
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

  const currentPage = resolveProductPage(requestedPage);
  const params = new URLSearchParams(rawQuery);
  const route = {
    ...DEFAULT_APP_ROUTE,
    currentPage,
  };

  if (currentPage === 'tasks') {
    route.filterProject = routeParam(params, 'project');
    route.taskSource = TASK_SOURCES.has(routeParam(params, 'source')) ? routeParam(params, 'source') : '';
    route.selectedWorkId = pathEntity || routeParam(params, 'workId');
    if (requestedPage === 'issues' && !route.selectedWorkId) {
      route.selectedWorkId = workIdFromIssueParam(params);
    }
    if (route.selectedWorkId) route.selectedRunId = routeParam(params, 'runId');
    else route.taskScope = TASK_SCOPES.has(routeParam(params, 'scope')) ? routeParam(params, 'scope') : '';
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
  const requestedPage = PRODUCT_ROUTE_ALIASES[route?.currentPage] || route?.currentPage;
  const page = ROUTABLE_PAGES.has(requestedPage) ? requestedPage : DEFAULT_APP_ROUTE.currentPage;
  const handoffId = cleanRouteValue(route?.selectedHandoffId);
  const workId = cleanRouteValue(route?.selectedWorkId);

  const deliveryHref = handoffId && (page === 'handoffs' || page === 'tasks')
    ? handoffHref(handoffId, page === 'tasks' ? workId : '')
    : '';
  if (deliveryHref && page === 'handoffs') return deliveryHref;

  const params = new URLSearchParams();
  if (page === 'tasks' && workId) {
    if (!deliveryHref) params.set('workId', workId);
    const runId = cleanRouteValue(route?.selectedRunId);
    if (runId) params.set('runId', runId);
  } else if (page === 'tasks' && TASK_SCOPES.has(route?.taskScope)) {
    params.set('scope', route.taskScope);
  }
  if (page === 'tasks') {
    if (TASK_SOURCES.has(route?.taskSource)) params.set('source', route.taskSource);
    const project = cleanRouteValue(route?.filterProject);
    if (project) params.set('project', project);
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
  return `${deliveryHref || `#/${encodeURIComponent(page)}`}${query ? `?${query}` : ''}`;
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
