export const PROJECT_SESSION_PAGE_SIZE = 5;

export function projectSessionVisibleCount(groupId, visibleCounts = {}) {
  return Math.max(PROJECT_SESSION_PAGE_SIZE, Number(visibleCounts[groupId]) || PROJECT_SESSION_PAGE_SIZE);
}

export function visibleProjectSessions(sessions, visibleCount = PROJECT_SESSION_PAGE_SIZE) {
  return sessions.slice(0, Math.max(PROJECT_SESSION_PAGE_SIZE, Number(visibleCount) || PROJECT_SESSION_PAGE_SIZE));
}

export function nextProjectSessionVisibleCount(currentCount, loadedCount) {
  const current = Math.max(PROJECT_SESSION_PAGE_SIZE, Number(currentCount) || PROJECT_SESSION_PAGE_SIZE);
  const loaded = Math.max(0, Number(loadedCount) || 0);
  return Math.min(current + PROJECT_SESSION_PAGE_SIZE, loaded);
}

export function projectSessionMoreState(loadedCount, visibleCount) {
  const loaded = Math.max(0, Number(loadedCount) || 0);
  const visible = Math.min(Math.max(PROJECT_SESSION_PAGE_SIZE, Number(visibleCount) || PROJECT_SESSION_PAGE_SIZE), loaded);
  return {
    hiddenLoadedCount: Math.max(loaded - visible, 0),
    canRevealLoaded: loaded > visible,
  };
}
