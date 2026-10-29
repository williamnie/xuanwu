import { holdReasonLabel } from './projectHold.js';

const STARTABLE_STATUSES = new Set(['triage']);
const CANCELLABLE_STATUSES = new Set(['triage', 'todo', 'in_progress', 'needs_user', 'failed']);
const RETRYABLE_STATUSES = new Set(['failed']);

export const WORK_TIMELINE_KINDS = [
  'work_event',
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

export const WORK_DETAIL_TABS = ['result', 'description', 'runs', 'activity'];

// 打开任务时默认看哪个 Tab：深链优先，其余按状态选用户此刻最关心的内容。
export function defaultWorkDetailTab(status, { selectedHandoffId = '', selectedRunId = '' } = {}) {
  if (selectedHandoffId) return 'result';
  if (selectedRunId) return 'runs';
  if (status === 'triage' || status === 'todo') return 'description';
  if (status === 'in_progress') return 'runs';
  return 'result';
}

// 未返回 schedule 的旧响应 / 创建草稿仍显示已有项目事实；新投影由共享组件呈现。
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
  return items.filter(item => item?.kind !== 'run' && item?.kind !== 'issue_event' && (!kind || item?.kind === kind));
}
