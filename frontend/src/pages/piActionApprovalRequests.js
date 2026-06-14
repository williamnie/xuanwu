const APPROVAL_REQUEST_PREFIX = 'approval-request:';

export async function loadPendingApprovals(apiClient) {
  const [actions, approvalRequests] = await Promise.all([
    apiClient.pendingActions(),
    apiClient.pendingApprovalRequests(),
  ]);
  return [
    ...(Array.isArray(approvalRequests) ? approvalRequests.map(approvalRequestAction) : []),
    ...(Array.isArray(actions) ? actions : []),
  ];
}

export function isApprovalRequestID(id) {
  return String(id || '').startsWith(APPROVAL_REQUEST_PREFIX);
}

export function approvalRequestID(id) {
  return String(id || '').slice(APPROVAL_REQUEST_PREFIX.length);
}

export function approvalRequestAction(request) {
  const resolverError = String(request.resolver_error || '').trim();
  const summary = request.request_summary || 'Codex executor 请求授权';
  const rationale = resolverError ? `${summary}\n上次回写 Codex 失败：${resolverError}` : summary;
  return {
    action_type: `codex.approval.${request.request_type || 'request'}`,
    gate_reason: rationale,
    id: `${APPROVAL_REQUEST_PREFIX}${request.approval_id}`,
    issue_id: request.issue_id,
    payload_json: JSON.stringify({
      approval_id: request.approval_id,
      delivery_channel: request.delivery_channel,
      provider: request.provider,
      resolver_error: resolverError,
      resolver_retryable: request.resolver_retryable,
      resolver_status: request.resolver_status,
      status: request.status,
      thread_id: request.thread_id,
      turn_id: request.turn_id,
    }),
    project_id: request.project_id,
    rationale,
    risk_level: request.risk || 'medium',
    source: 'codex_approval',
  };
}

export function resolveApprovalRequestDecision(apiClient, id, decision) {
  const requestID = approvalRequestID(id);
  if (decision === 'approve') return apiClient.resolveApprovalRequest(requestID, 'approve', 'turn');
  if (decision === 'request_changes') return apiClient.resolveApprovalRequest(requestID, 'approve_session', 'session');
  if (decision === 'snooze') return apiClient.resolveApprovalRequest(requestID, 'defer', 'turn');
  return apiClient.resolveApprovalRequest(requestID, 'deny', 'turn');
}
