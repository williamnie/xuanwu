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
    `Evidence: ${(handoff.evidence_ids || []).join(', ') || 'none'}`,
    `Risks: ${(handoff.risks || []).length}`,
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
  if (status === 'delivered' || status === 'succeeded') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'delivering' || status === 'sending' || status === 'retry') return 'amber';
  if (status === 'ready') return 'blue';
  return 'slate';
}
