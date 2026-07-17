export const ATTENTION_PRIORITIES = ['p0', 'p1', 'p2', 'p3'];

export function groupAttentionByPriority(items = []) {
  const groups = Object.fromEntries(ATTENTION_PRIORITIES.map(priority => [priority, []]));
  for (const item of items) {
    if (groups[item?.priority]) groups[item.priority].push(item);
  }
  return groups;
}

export function attentionActionPayload(item, action, { nonce = eventNonce(), occurredAt = new Date().toISOString() } = {}) {
  const payload = {
    audit: {
      actor: { id: 'frontend:user', kind: 'user' },
      correlation_id: `command-center:${item?.id || 'unknown'}`,
      event_id: `command-center:attention:${action}:${nonce}`,
      gate: { authority: 'human_approval', decision: 'allow', policy_ref: 'command-center:human-attention-action' },
      occurred_at: occurredAt,
      reason: `Command Center user requested Attention ${action}`,
    },
    expected_revision: Number(item?.revision || 0),
  };
  if (action === 'snooze') payload.snoozed_until = new Date(new Date(occurredAt).getTime() + 60 * 60 * 1000).toISOString();
  return payload;
}

export function attentionView(item, now = new Date()) {
  const snoozed = item?.snoozed_until && new Date(item.snoozed_until).getTime() > now.getTime();
  return {
    actionLabel: item?.next_action || '查看来源并处理该事项',
    canAcknowledge: item?.status === 'open' || item?.status === 'waiting',
    canSnooze: item?.status === 'open' || item?.status === 'acknowledged',
    statusLabel: snoozed ? `已暂停至 ${new Date(item.snoozed_until).toLocaleTimeString()}` : statusLabel(item?.status),
    tone: item?.priority || 'p3',
    typeLabel: typeLabel(item?.type),
  };
}

function statusLabel(status) {
  return ({ acknowledged: '已确认', open: '待处理', waiting: '等待中' })[status] || '待处理';
}

function typeLabel(type) {
  return ({
    approval_required: '等待审批',
    blocker: '阻塞',
    connection_issue: '连接异常',
    failure: '失败',
    input_required: '等待输入',
    verification_required: '待验收',
  })[type] || '需要关注';
}

function eventNonce() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
