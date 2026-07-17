const HANDOFF_HASH_PREFIX = '#/handoffs/';

export function handoffHref(id) {
  const value = String(id || '').trim();
  return value ? `${HANDOFF_HASH_PREFIX}${encodeURIComponent(value)}` : '#/handoffs';
}

export function handoffRouteFromHash(hash) {
  const value = String(hash || '');
  if (!value.startsWith(HANDOFF_HASH_PREFIX)) return null;
  const encoded = value.slice(HANDOFF_HASH_PREFIX.length);
  if (!encoded || encoded.includes('/')) return null;
  try {
    const handoffId = decodeURIComponent(encoded).trim();
    if (!/^xw:handoff:derived:[A-Za-z0-9._~%-]+$/.test(handoffId)) return null;
    return { handoffId, page: 'handoffs' };
  } catch {
    return null;
  }
}

export function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

export function handoffCopyText(detail) {
  const handoff = detail?.handoff;
  if (!handoff) return '';
  const delivery = handoff.delivery || {};
  const lines = [
    `Handoff: ${handoff.id}`,
    `Status: ${handoff.status}`,
    `Summary: ${handoff.summary}`,
    delivery.branch_ref ? `Branch: ${delivery.branch_ref}` : '',
    delivery.commit_ref ? `Commit: ${delivery.commit_ref}` : '',
    delivery.pull_request_ref ? `PR: ${delivery.pull_request_ref}` : '',
    delivery.deployment_ref ? `Deployment: ${delivery.deployment_ref}` : '',
    delivery.environment ? `Environment: ${delivery.environment}` : '',
    delivery.release_ref ? `Release: ${delivery.release_ref}` : '',
    delivery.version ? `Version: ${delivery.version}` : '',
    `Evidence: ${(handoff.evidence_ids || []).join(', ') || 'none'}`,
    `Review: ${detail?.review_summary?.state || handoff.review?.state || 'unknown'}`,
    `Risks: ${(handoff.risks || []).length}`,
    `Rollback: ${handoff.rollback?.availability || 'unknown'}`,
    `Next: ${detail?.notification_summary?.next_step || 'Review delivery status'}`,
  ];
  return lines.filter(Boolean).join('\n');
}

export function displayRef(value, head = 12, tail = 8) {
  const text = String(value || '');
  if (text.length <= head + tail + 1) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

export function deliveryTone(status) {
  if (status === 'accepted' || status === 'approved' || status === 'delivered' || status === 'succeeded') return 'green';
  if (status === 'changes_requested' || status === 'failed') return 'red';
  if (status === 'blocked' || status === 'delivering' || status === 'sending' || status === 'retry') return 'amber';
  if (status === 'pending' || status === 'ready') return 'blue';
  return 'slate';
}

export function handoffReviewActions(detail) {
  const handoff = detail?.handoff;
  const state = detail?.review_summary?.state || handoff?.review?.state;
  if (handoff?.status !== 'ready' || state !== 'pending') return [];
  const allowed = detail?.review_summary?.available_actions;
  return Array.isArray(allowed)
    ? allowed.filter(action => action === 'accept' || action === 'request_changes')
    : ['accept', 'request_changes'];
}

export function handoffReviewPayload(detail, action, comment = '', options = {}) {
  if (!handoffReviewActions(detail).includes(action)) throw new Error(`Review action ${action} is unavailable`);
  const handoff = detail.handoff;
  const body = String(comment || '').trim();
  if (action === 'request_changes' && !body) throw new Error('Request changes requires a comment');
  const occurredAt = options.occurredAt || new Date().toISOString();
  const nonce = String(options.nonce || globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const actorRef = String(options.actorRef || 'user:local-operator');
  return {
    action,
    audit: {
      actor: { id: actorRef, kind: 'user' },
      correlation_id: `handoff-review:${handoff.id}`,
      event_id: `handoff-review-ui:${nonce}`,
      occurred_at: occurredAt,
      reason: body || `Handoff review ${action}`,
    },
    comment: body,
    expected_revision: Number(handoff.revision || 0),
  };
}

const RISK_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

export function handoffRiskPresentation(risks) {
  const items = Array.isArray(risks) ? [...risks] : [];
  items.sort((left, right) => (RISK_RANK[right?.severity] || 0) - (RISK_RANK[left?.severity] || 0));
  const counts = items.reduce((result, risk) => {
    if (Object.hasOwn(RISK_RANK, risk?.severity)) result[risk.severity] += 1;
    return result;
  }, { critical: 0, high: 0, medium: 0, low: 0 });
  return {
    counts,
    highest: items[0]?.severity || 'none',
    items,
  };
}
