export function pendingApprovalCount(data) {
  return Number(data?.overview?.pending_approvals || 0);
}

export function approvalCalloutState(count) {
  const pendingCount = Number(count || 0);
  if (pendingCount > 0) {
    return {
      detail: '先确认下方动作的原因、风险和范围，再决定批准、要求修改、暂缓或拒绝。',
      status: '需要你处理',
      title: `${pendingCount} 项待审批动作优先处理`,
      tone: 'needs-action',
    };
  }
  return {
    detail: '新的 confirm/high 风险动作会出现在这里；需要时再查看下方证据模块。',
    status: '当前无阻塞',
    title: '暂无待审批动作',
    tone: 'clear',
  };
}
