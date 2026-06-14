export function pendingApprovalCount(data) {
  return Number(data?.overview?.pending_approvals || 0);
}

export function approvalCalloutState(count) {
  const pendingCount = Number(count || 0);
  if (pendingCount > 0) {
    return {
      detail: '日常确认请优先在 Feishu IM 或对应 issue detail 完成；这里保留高级排障入口，可复核原因、风险和范围。',
      status: '诊断提示',
      title: `${pendingCount} 项待确认动作可供审计`,
      tone: 'needs-action',
    };
  }
  return {
    detail: '新的 confirm/high 风险动作仍会保留在审计区；日常审批入口以 IM 和 issue detail 为主。',
    status: '诊断正常',
    title: '暂无待确认审计项',
    tone: 'clear',
  };
}
