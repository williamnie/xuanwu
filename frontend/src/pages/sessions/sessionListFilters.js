export const SESSION_LIST_FILTER_ALL = 'all';
export const SESSION_LIST_FILTER_RUNNING = 'running';
export const SESSION_LIST_FILTER_RECENT = 'recent';
export const SESSION_LIST_RECENT_WINDOW_SECONDS = 7 * 24 * 60 * 60;

const RUNNING_STATUS_VALUES = new Set(['running', 'inprogress', 'in-progress', 'streaming', 'busy']);

export function isSessionListFilterActive({ query = '', mode = SESSION_LIST_FILTER_ALL } = {}) {
  return normalizeText(query) !== '' || mode !== SESSION_LIST_FILTER_ALL;
}

export function filterProjectSessionGroups(groups, options = {}) {
  const query = normalizeText(options.query);
  const mode = options.mode || SESSION_LIST_FILTER_ALL;
  const nowSeconds = Number(options.nowSeconds) || Math.floor(Date.now() / 1000);
  const recentWindowSeconds = Number(options.recentWindowSeconds) || SESSION_LIST_RECENT_WINDOW_SECONDS;

  if (!query && mode === SESSION_LIST_FILTER_ALL) return groups;

  return groups
    .map((group) => filterProjectSessionGroup(group, { query, mode, nowSeconds, recentWindowSeconds }))
    .filter((group) => group.sessions.length > 0);
}

function filterProjectSessionGroup(group, options) {
  const projectMatches = sessionSearchText(group).includes(options.query);
  const sessions = (group.sessions || []).filter((session) => {
    if (!matchesSessionMode(session, options)) return false;
    if (!options.query || projectMatches) return true;
    return sessionSearchText(session).includes(options.query);
  });
  return { ...group, sessions };
}

function matchesSessionMode(session, { mode, nowSeconds, recentWindowSeconds }) {
  if (mode === SESSION_LIST_FILTER_RUNNING) return isSessionRunning(session);
  if (mode === SESSION_LIST_FILTER_RECENT) return isSessionRecent(session, nowSeconds, recentWindowSeconds);
  return true;
}

function isSessionRunning(session) {
  if (session?.isRunning) return true;
  if (Array.isArray(session?.pending_approvals) && session.pending_approvals.length > 0) return true;
  return RUNNING_STATUS_VALUES.has(sessionStatusValue(session?.status));
}

function isSessionRecent(session, nowSeconds, recentWindowSeconds) {
  const timestamp = Number(session?.updatedAt || session?.createdAt || 0);
  return timestamp > 0 && nowSeconds - timestamp <= recentWindowSeconds;
}

function sessionStatusValue(status) {
  if (!status) return '';
  if (typeof status === 'string') {
    try {
      return sessionStatusValue(JSON.parse(status));
    } catch {
      return normalizeStatus(status);
    }
  }
  return normalizeStatus(status.type || status.state || status.status || '');
}

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase().replaceAll('_', '-');
}

function sessionSearchText(item) {
  return normalizeText([
    item?.name,
    item?.preview,
    item?.id,
    item?.sessionId,
    item?.provider_session_id,
    item?.providerSessionId,
    item?.providerSessionID,
    item?.cwd,
  ].filter(Boolean).join(' '));
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}
