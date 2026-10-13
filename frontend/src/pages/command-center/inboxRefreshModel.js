const ISSUE_EVENTS = new Set(['issue.created', 'issue.deleted', 'issue.updated', 'issue.status_changed']);
export function isInboxStateEvent(type) {
  const value = String(type || '');
  return ISSUE_EVENTS.has(value) || /^(approval\.|attention\.|issue\.human_review[._]|pi\.(needs_user|approval[._]|action[._]|proposal[._]|guardian[._]alert)|guardian[._]alert)/.test(value);
}
export function inboxRefreshDecision(type, { loading, paged }) {
  if (!isInboxStateEvent(type)) return 'ignore';
  return loading || paged ? 'notify' : 'refresh';
}
