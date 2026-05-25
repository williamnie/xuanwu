const LAST_STATUS_LABELS = {
  success: 'Success',
  skipped: 'Skipped',
  failed: 'Failed',
};

export function buildCronRunSummary(task = {}) {
  const error = task.last_error || task.error || '';
  const status = resolveLastStatus(task, error);
  return {
    lastRunAt: task.last_run_at || '',
    nextRunAt: task.next_run_at || '',
    status,
    statusLabel: LAST_STATUS_LABELS[status] || 'Not run',
    badgeClass: cronRunStatusBadgeClass(status),
    result: task.last_result || '',
    error,
  };
}

export function resolveLastStatus(task = {}, error = '') {
  if (task.last_status) return task.last_status;
  if (error) return 'failed';
  if (task.last_run_at) return 'success';
  return '';
}

export function cronRunStatusBadgeClass(status) {
  if (status === 'success') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'skipped') return 'triage';
  return 'todo';
}
