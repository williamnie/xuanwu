export const EVIDENCE_STATUS_META = {
  blocked: { label: 'Blocked', tone: 'blocked' },
  failed: { label: 'Failed', tone: 'failed' },
  passed: { label: 'Passed', tone: 'passed' },
  pending: { label: 'Pending', tone: 'pending' },
};

export function evidenceStatusMeta(status) {
  return EVIDENCE_STATUS_META[status] || { label: status || 'Unknown', tone: 'unknown' };
}

export function decisiveEvidence(items = []) {
  return items.find(item => item?.status === 'failed' || item?.status === 'blocked')
    || items.find(item => item?.status === 'passed')
    || items[0]
    || null;
}

export function decisiveEvidenceText(item) {
  if (!item) return '暂无结构化验证证据。';
  const prefix = item.status === 'failed' || item.status === 'blocked' ? '未通过：' : '';
  return `${prefix}${item.decisive_summary || '未提供决定性摘要'}`;
}

export function evidenceScopeLabel(item) {
  const parts = [item?.kind || 'unknown'];
  if (item?.exit_code !== null && item?.exit_code !== undefined) parts.push(`exit ${item.exit_code}`);
  if (item?.attempt_id) parts.push(String(item.attempt_id).split('~attempt:').at(-1) ? `Attempt ${String(item.attempt_id).split('~attempt:').at(-1)}` : '');
  return parts.filter(Boolean).join(' · ');
}

export function mergeEvidencePages(current = [], incoming = []) {
  const byId = new Map(current.map(item => [item.id, item]));
  incoming.forEach(item => byId.set(item.id, item));
  return [...byId.values()];
}
