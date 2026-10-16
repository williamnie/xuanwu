export function workScheduleSummary(work, t) {
  if (work?.status !== 'todo' || !work.schedule) return '';
  const reason = work.schedule.reasons?.[0];
  return reason ? scheduleReasonText(reason, t) : t('schedule.runnable');
}

export function scheduleReasonText(reason, t) {
  const key = reason?.code === 'project_busy' && reason.detail?.holder === 'awaiting_user'
    ? 'schedule.project_busy_awaiting_user' : `schedule.${reason?.code || 'unknown'}`;
  const text = t(key);
  // 后端新增的 code 在前端尚未配文案时退回通用说明，不显示原始键名。
  return text === key ? t('schedule.unknown') : text;
}

export function scheduleBlockers(reason) {
  const seen = new Set();
  return (reason?.detail?.root_blockers || []).filter(blocker => {
    if (!/^xw:work:issues:[1-9]\d*$/.test(blocker.work_id) || blocker.status === 'missing' || seen.has(blocker.work_id)) return false;
    seen.add(blocker.work_id);
    return true;
  });
}

export function scheduleWorkHref(workId) {
  return `#/tasks?workId=${encodeURIComponent(workId)}`;
}
