import { holdReasonLabel } from './projectHold.js';

const STARTABLE_STATUSES = new Set(['triage']);
const CANCELLABLE_STATUSES = new Set(['triage', 'todo', 'in_progress', 'needs_user', 'failed']);
const RETRYABLE_STATUSES = new Set(['failed']);

export const WORK_TIMELINE_KINDS = [
  'work_event',
  'issue_event',
  'run',
  'evidence',
  'handoff',
  'approval',
];

export function workAvailableActions(status, decision = null) {
  return {
    cancel: CANCELLABLE_STATUSES.has(status),
    edit: status !== 'in_progress',
    retry: RETRYABLE_STATUSES.has(status),
    review: status === 'needs_user'
      && decision?.owner === 'human'
      && decision?.request?.status === 'open',
    start: STARTABLE_STATUSES.has(status),
  };
}

// 只说明接口已提供、能可靠关联的阻塞事实；依赖与调度诊断尚无投影，不猜测。
export function workBlockReason(work, project) {
  if (!work || !project || !['todo', 'triage'].includes(work.status)) return '';
  if (project.hold) return `项目已暂停（${holdReasonLabel(project.hold.reason)}），恢复后才会开始。`;
  if (work.status === 'todo' && Number(project.auto_run) !== 1) return '项目未开启自动执行，排队的任务不会自动开始。';
  return '';
}

export function buildWorkActionPayload(work, action, {
  nonce,
  occurredAt = new Date().toISOString(),
} = {}) {
  const eventNonce = String(
    nonce || globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  return {
    audit: {
      actor: { id: 'work-detail-user', kind: 'user' },
      correlation_id: `work-detail:${work?.id || 'unknown'}`,
      event_id: `work-detail:${action}:${eventNonce}`,
      occurred_at: occurredAt,
      reason: `User requested Work ${action} from Work Detail`,
    },
    expected_revision: Number(work?.revision || 0),
  };
}

export function mergeTimelinePages(current = [], incoming = []) {
  const merged = new Map();
  [...current, ...incoming].forEach(item => {
    if (item?.id) merged.set(item.id, item);
  });
  return [...merged.values()].sort((left, right) => {
    const time = Date.parse(right.occurred_at || '') - Date.parse(left.occurred_at || '');
    return time || String(right.id).localeCompare(String(left.id));
  });
}

export function filterTimelineItems(items = [], kind = '') {
  return kind ? items.filter(item => item?.kind === kind) : items;
}
