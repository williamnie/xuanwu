export const WORK_BOARD_STATUSES = [
  'triage',
  'todo',
  'in_progress',
  'pending_verification',
  'failed',
  'done',
  'cancelled',
];

export const WORK_BOARD_TYPES = ['objective', 'engineering_task'];

const ATTENTION_STATUSES = new Set(['triage', 'pending_verification', 'failed']);
const ATTENTION_RELATION_LIFECYCLES = new Set(['pending', 'paused', 'failed', 'legacy_unknown']);

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

export function indexRelationsByWork(relations = []) {
  const index = new Map();
  relations.forEach((relation) => {
    if (!relation?.work_id) return;
    const current = index.get(relation.work_id) || [];
    current.push(relation);
    index.set(relation.work_id, current);
  });
  return index;
}

export function workNeedsAttention(work, relations = []) {
  if (ATTENTION_STATUSES.has(work?.status)) return true;
  return relations.some(relation => ATTENTION_RELATION_LIFECYCLES.has(relation.lifecycle));
}

export function workDeliveryStage(work) {
  if (work?.status === 'done') return 'delivered';
  if (work?.status === 'cancelled') return 'closed';
  if (work?.status === 'pending_verification') return 'verification';
  return 'outstanding';
}

export function filterWorkBoardItems(works, relationsByWork, filters) {
  const query = String(filters.query || '').trim().toLowerCase();
  return works.filter((work) => {
    const relations = relationsByWork.get(work.id) || [];
    if (filters.type && work.type !== filters.type) return false;
    if (filters.status && work.status !== filters.status) return false;
    if (filters.project && work.owner?.project_id !== filters.project) return false;
    if (filters.attention === 'required' && !workNeedsAttention(work, relations)) return false;
    if (filters.attention === 'clear' && workNeedsAttention(work, relations)) return false;
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
  if (['done', 'failed', 'pending_verification'].includes(targetStatus)) return 'blocked';
  if (['done', 'cancelled'].includes(currentStatus)) return 'blocked';
  if (currentStatus === 'pending_verification') return targetStatus === 'cancelled' ? 'cancel' : 'blocked';
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
