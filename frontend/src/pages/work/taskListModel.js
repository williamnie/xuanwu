// 任务页四个筛选（方案 5.4）：进行中 = 排队中 + 执行中；待你处理 = 待确认 + 待你处理 + 失败。
export const TASK_SCOPES = [
  { id: 'active', label: '进行中', statuses: ['todo', 'in_progress'] },
  { id: 'attention', label: '待你处理', statuses: ['triage', 'needs_user', 'failed'] },
  { id: 'done', label: '已完成', statuses: ['done'] },
  { id: 'all', label: '全部', statuses: [] },
];

export function scopeCount(scope, counts) {
  if (scope.id === 'all') return counts.total ?? '';
  const values = scope.statuses.map(status => counts[status]);
  return values.every(value => typeof value === 'number') ? values.reduce((sum, value) => sum + value, 0) : '';
}
