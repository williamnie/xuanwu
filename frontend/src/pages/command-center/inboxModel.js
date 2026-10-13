export function humanReviewPayload(request, action, comment = '') {
  if (!['accept','reject','request_changes'].includes(action)) throw new Error('不支持的审核动作');
  if (action !== 'accept' && !comment.trim()) throw new Error('请填写意见');
  return { action, actor: 'frontend:user', comment, review_request_id: request.id, review_revision: request.revision };
}
export function providerApprovalPayload(decision, reason = '') {
  if (decision.kind !== 'provider_approval') throw new Error('执行工具审批类型不匹配');
  return { actor: 'frontend:user', decision_ref: decision.ref, reason: reason.trim(), scope: 'turn' };
}
export function proposalDecisionPayload(decision, reason = '') {
  if (decision.kind !== 'proposal') throw new Error('操作提案类型不匹配');
  return { actor: 'frontend:user', decision_ref: decision.ref, reason: reason.trim() };
}
export function piActionDecisionPayload(decision, comment = '') {
  if (decision.kind !== 'pi_action') throw new Error('助手动作类型不匹配');
  return { actor: 'frontend:user', decision_ref: decision.ref, comment: comment.trim(), reason: comment.trim() };
}
export function mergeInboxPages(current, incoming) {
  return [...new Map([...current,...incoming].map(item=>[item.key,item])).values()];
}
export function reviewConflictMessage(previous, current) {
  const request = current?.decision?.request;
  if (!request || request.status !== 'open' || current.decision.owner !== 'human') return '请求已处理或失效，已刷新当前状态';
  if (request.id !== previous.id) return '原请求已失效，已显示新的请求';
  if (request.revision !== previous.revision) return '请求内容已更新，请重新核对';
  return '审核条件已变化，请核对当前任务';
}
