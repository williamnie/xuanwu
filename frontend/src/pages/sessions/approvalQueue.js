export function enqueueApprovalNotice(queue, notice) {
  const key = approvalRequestKey(notice?.request);
  if (!key) return queue;
  if (queue.some((item) => approvalRequestKey(item.request) === key)) return queue;
  return [...queue, notice];
}

export function removeApprovalRequest(queue, request) {
  const key = approvalRequestKey(request);
  if (!key) return queue;
  return queue.filter((item) => approvalRequestKey(item.request) !== key);
}

export function removeApprovalsForSession(queue, sessionId) {
  return queue.filter((item) => item.sessionId !== sessionId);
}

export function syncApprovalsForSession(queue, sessionId, requests) {
  const withoutSession = removeApprovalsForSession(queue, sessionId);
  return (requests || []).reduce(
    (next, request) => enqueueApprovalNotice(next, { sessionId, request }),
    withoutSession,
  );
}

export function approvalsForSession(queue, sessionId) {
  return queue.filter((item) => item.sessionId === sessionId);
}

export function hasApprovalForSession(queue, sessionId) {
  return queue.some((item) => item.sessionId === sessionId);
}

function approvalRequestKey(request) {
  return String(request?.id || '').trim();
}
