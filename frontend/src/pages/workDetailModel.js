const STARTABLE_STATUSES = new Set(['triage']);
const CANCELLABLE_STATUSES = new Set(['triage', 'todo', 'in_progress', 'pending_verification', 'failed']);
const RETRYABLE_STATUSES = new Set(['failed']);

export const WORK_TIMELINE_KINDS = [
  'work_event',
  'issue_event',
  'run',
  'evidence',
  'handoff',
  'approval',
];

export function workAvailableActions(status, verification = null) {
  return {
    cancel: CANCELLABLE_STATUSES.has(status),
    edit: status !== 'in_progress',
    retry: RETRYABLE_STATUSES.has(status),
    review: status === 'pending_verification'
      && verification?.owner === 'human'
      && verification?.request?.status === 'open',
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
