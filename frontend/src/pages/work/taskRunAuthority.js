export function canOperateTaskRun(run, workId, runId, attempt) {
  const latest = run?.attempts?.at(-1);
  return Boolean(workId && run?.work_id === workId && run.id === runId && latest?.id && attempt?.id === latest.id);
}
