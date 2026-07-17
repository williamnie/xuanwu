const STARTABLE_STATUSES = new Set(['triage']);
const CANCELLABLE_STATUSES = new Set(['triage', 'todo', 'in_progress', 'pending_verification', 'failed']);
const RETRYABLE_STATUSES = new Set(['failed']);

const ATTENTION_WORK_STATUSES = {
  failed: 'Work 执行失败，需要决定重试或调整目标。',
  pending_verification: 'Work 正在等待验收结论。',
  triage: 'Work 尚未进入执行队列。',
};

const ATTENTION_RELATION_LIFECYCLES = new Set(['failed', 'legacy_unknown', 'paused', 'pending']);
const RESOLVED_APPROVAL_STATUSES = new Set(['approved', 'cancelled', 'denied', 'expired', 'rejected', 'resolved']);

export const WORK_TIMELINE_KINDS = [
  'work_event',
  'issue_event',
  'run',
  'evidence',
  'handoff',
  'approval',
];

export function workAvailableActions(status) {
  return {
    cancel: CANCELLABLE_STATUSES.has(status),
    edit: status !== 'in_progress',
    retry: RETRYABLE_STATUSES.has(status),
    review: status === 'pending_verification',
    start: STARTABLE_STATUSES.has(status),
  };
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

export function workAttentionSignals(work, relations = [], timeline = [], guardianAlerts = []) {
  const signals = [];
  const statusSummary = ATTENTION_WORK_STATUSES[work?.status];
  if (statusSummary) {
    signals.push({
      detail: statusSummary,
      id: `work-status:${work?.status}`,
      kind: 'work',
      status: work?.status,
      title: work?.status === 'pending_verification' ? '等待验收' : work?.status === 'failed' ? '执行失败' : '等待规划',
    });
  }

  relations
    .filter(relation => ATTENTION_RELATION_LIFECYCLES.has(relation?.lifecycle))
    .forEach(relation => signals.push({
      detail: `${relation.kind || 'relation'} carrier 当前为 ${relation.lifecycle}`,
      id: `relation:${relation.relation_id || relation.source_ref?.external_id || signals.length}`,
      kind: 'relationship',
      status: relation.lifecycle,
      title: '关联工作需要处理',
    }));

  currentApprovalSignals(timeline).forEach(item => signals.push({
    detail: item.summary || item.title,
    id: `approval:${item.source?.external_id || item.id}`,
    kind: 'approval',
    status: item.status,
    title: item.title || '等待确定性权限门禁',
  }));

  guardianAlerts
    .filter(alert => alert?.status === 'open')
    .forEach(alert => signals.push({
      detail: alert.message || alert.alert_type,
      id: `guardian:${alert.id}`,
      kind: 'guardian',
      status: alert.severity || 'open',
      title: alert.alert_type || 'Guardian alert',
    }));

  return dedupeById(signals);
}

function currentApprovalSignals(timeline) {
  const latest = new Map();
  timeline
    .filter(item => item?.kind === 'approval')
    .forEach(item => {
      const key = item.source?.external_id || item.id;
      const current = latest.get(key);
      if (!current || Date.parse(item.occurred_at || '') > Date.parse(current.occurred_at || '')) {
        latest.set(key, item);
      }
    });
  return [...latest.values()].filter(item => !RESOLVED_APPROVAL_STATUSES.has(String(item.status || '').toLowerCase()));
}

function dedupeById(items) {
  return [...new Map(items.map(item => [item.id, item])).values()];
}
