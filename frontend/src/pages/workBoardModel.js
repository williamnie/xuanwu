export const WORK_BOARD_STATUSES = [
  'triage',
  'todo',
  'in_progress',
  'needs_user',
  'failed',
  'done',
  'cancelled',
];

export const WORK_BOARD_TYPES = ['objective', 'engineering_task'];

export function laneScrollDecision({ armed, clientHeight, scrollHeight, scrollTop }, threshold = 160) {
  const remaining = scrollHeight - scrollTop - clientHeight;
  const nearEnd = scrollHeight > clientHeight && remaining <= threshold;
  if (!nearEnd) return { armed: true, load: false };
  if (!armed) return { armed: false, load: false };
  return { armed: false, load: true };
}

const ATTENTION_STATUSES = new Set(['triage', 'needs_user', 'failed']);

export function workBoardEnabled(env = {}) {
  const value = String(env?.VITE_WORK_BOARD_ENABLED ?? 'true').trim().toLowerCase();
  return !['0', 'false', 'off'].includes(value);
}

export const WORK_BOARD_ENABLED = workBoardEnabled(import.meta.env);

export function resolveWorkBoardPage(page, enabled = WORK_BOARD_ENABLED) {
  return page === 'work' && !enabled ? 'issues' : page;
}

export function issueIdFromWorkId(workId) {
  const match = /^xw:work:issues:([1-9]\d*)$/.exec(String(workId || ''));
  return match ? Number(match[1]) : null;
}

export function workIdFromIssueId(issueId) {
  const value = Number(issueId);
  return Number.isSafeInteger(value) && value > 0 ? `xw:work:issues:${value}` : '';
}

export function workNeedsAttention(work) {
  return ATTENTION_STATUSES.has(work?.status);
}

export function workDeliveryStage(work) {
  if (work?.status === 'done') return 'delivered';
  if (work?.status === 'cancelled') return 'closed';
  if (work?.status === 'needs_user') return 'attention';
  return 'outstanding';
}

export function filterWorkBoardItems(works, filters) {
  const query = String(filters.query || '').trim().toLowerCase();
  return works.filter((work) => {
    if (filters.type && work.type !== filters.type) return false;
    if (filters.status && work.status !== filters.status) return false;
    if (filters.project && work.owner?.project_id !== filters.project) return false;
    if (filters.attention === 'required' && !workNeedsAttention(work)) return false;
    if (filters.attention === 'clear' && workNeedsAttention(work)) return false;
    if (filters.delivery && workDeliveryStage(work) !== filters.delivery) return false;
    if (query && !`${work.title || ''}\n${work.goal || ''}\n${work.id || ''}`.toLowerCase().includes(query)) return false;
    return true;
  });
}

export function groupWorksByStatus(works) {
  const groups = new Map(WORK_BOARD_STATUSES.map(status => [status, []]));
  works.forEach((work) => {
    if (!groups.has(work.status)) groups.set(work.status, []);
    groups.get(work.status).push(work);
  });
  return groups;
}

export function workDropOperation(currentStatus, targetStatus) {
  if (currentStatus === targetStatus) return 'none';
  if (['done', 'failed', 'needs_user'].includes(targetStatus)) return 'blocked';
  if (['done', 'cancelled'].includes(currentStatus)) return 'blocked';
  if (currentStatus === 'needs_user') return targetStatus === 'cancelled' ? 'cancel' : 'blocked';
  if (targetStatus === 'cancelled') return 'cancel';
  if (targetStatus === 'todo') {
    if (currentStatus === 'in_progress' || currentStatus === 'failed') return 'retry';
    return currentStatus === 'triage' ? 'update' : 'blocked';
  }
  if (targetStatus === 'in_progress') {
    if (currentStatus === 'failed') return 'retry';
    return currentStatus === 'triage' || currentStatus === 'todo' ? 'enqueue' : 'blocked';
  }
  if (targetStatus === 'triage') return currentStatus === 'todo' || currentStatus === 'failed' ? 'update' : 'blocked';
  return 'blocked';
}
