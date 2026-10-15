export function workScheduleSummary(work, t) {
  if (work?.status !== 'todo' || !work.schedule) return '';
  const reason = work.schedule.reasons?.[0];
  return reason ? scheduleReasonText(reason, t) : t('schedule.runnable');
}

export function scheduleReasonText(reason, t) {
  return t(`schedule.${reason?.code || 'unknown'}`);
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
