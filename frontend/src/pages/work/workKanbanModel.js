import { WORK_BOARD_STATUSES } from '../workBoardModel.js';

const HISTORY_STATUSES = ['done', 'cancelled'];
export function mergeWorks(current, incoming) {
  const merged = new Map(current.map(work => [work.id, work]));
  incoming.forEach(work => merged.set(work.id, work));
  return [...merged.values()];
}

export function mergeOperationalSnapshot(current, refreshed) {
  const refreshedIds = new Set(refreshed.map(work => work.id));
  return [
    ...refreshed,
    ...current.filter(work => HISTORY_STATUSES.includes(work.status) && !refreshedIds.has(work.id)),
  ];
}

export function mergeRefreshedLanePages(current, refreshed) {
  return Object.fromEntries(WORK_BOARD_STATUSES.map(status => [
    status,
    HISTORY_STATUSES.includes(status) ? current[status] || refreshed[status] : {
      ...refreshed[status],
      page: Math.max(Number(current[status]?.page || 1), Number(refreshed[status]?.page || 1)),
    },
  ]));
}

export function normalizeBoardSnapshot(response, summary, sourceFiltered = false) {
  const lanePages = {};
  const items = [];
  let total = 0;
  WORK_BOARD_STATUSES.forEach((status) => {
    const lane = response?.lanes?.[status] || {};
    const history = HISTORY_STATUSES.includes(status);
    lanePages[status] = history
      ? normalizeLanePage({ total: sourceFiltered ? undefined : summary?.counts?.[status] || 0 }, response?.page_size || 20, 'not_loaded')
      : normalizeLanePage(lane, response?.page_size || 20, 'loaded');
    items.push(...(lane?.items || []));
    total += lanePages[status].total || 0;
  });
  return { items: mergeWorks([], items), lanePages, total };
}

export function normalizeLanePage(response, fallbackPageSize, loadState = 'loaded') {
  return {
    hasMore: Boolean(response?.has_more ?? (Number(response?.page || 1) < Number(response?.total_pages || 0))),
    loadState,
    nextCursor: String(response?.next_cursor || ''),
    page: Number(response?.page || 1),
    pageSize: Number(response?.page_size || fallbackPageSize || 20),
    total: response?.total === undefined ? undefined : Number(response.total),
    totalPages: Number(response?.total_pages || 0),
  };
}
