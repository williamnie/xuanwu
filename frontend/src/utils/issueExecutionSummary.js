const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled']);

export function deriveIssueExecutionSummary({ issue = {}, events = [], runs = [] } = {}) {
  const latestRun = latestRunFromList(runs) || issue.latest_run || null;
  const issueStatus = cleanText(issue.status) || 'unknown';
  const runStatus = cleanText(latestRun?.status) || '';
  const verification = structuredVerification(issue, events);
  const statusConflict = terminalStatus(issueStatus) && runStatus !== '' && issueStatus !== runStatus;

  return {
    issueStatus,
    latestRun,
    runStatus,
    statusConflict: Boolean(statusConflict),
    verification,
    nextAction: nextAction(issueStatus, latestRun, verification, Boolean(statusConflict)),
  };
}

function latestRunFromList(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return null;
  return runs.reduce((latest, run) => {
    if (!latest) return run;
    const attemptDelta = Number(run?.attempt || 0) - Number(latest?.attempt || 0);
    if (attemptDelta !== 0) return attemptDelta > 0 ? run : latest;
    return cleanText(run?.started_at) >= cleanText(latest?.started_at) ? run : latest;
  }, null);
}

function structuredVerification(issue, events) {
  const report = latestEvent(events, 'issue.verification_report');
  if (report) {
    const payload = parsePayload(report.payload);
    const recommendation = cleanText(payload.recommendation);
    return {
      state: recommendation === 'accept' ? 'recorded' : 'attention',
      label: recommendation ? `Verifier: ${recommendation}` : 'Verifier report 已记录',
      detail: cleanText(payload.summary) || '已记录结构化 verifier report。',
      source: 'verifier_report',
    };
  }

  const snapshot = parsePayload(issue.workflow_snapshot_json);
  const verify = Array.isArray(snapshot.steps)
    ? snapshot.steps.find((step) => cleanText(step?.id) === 'verify')
    : null;
  const evidence = cleanText(verify?.evidence_summary);
  if (verify && evidence) {
    const status = cleanText(verify.status);
    return {
      state: status === 'done' ? 'recorded' : 'attention',
      label: `Snapshot: ${status || 'recorded'}`,
      detail: evidence,
      source: 'workflow_snapshot',
    };
  }

  return {
    state: issue.status === 'done' ? 'attention' : 'missing',
    label: '未记录结构化验证',
    detail: issue.status === 'done'
      ? '任务状态为 done，但没有 verifier report 或 workflow snapshot 验证证据。'
      : '执行结束后可生成 verifier report，或由运行态写入验证快照。',
    source: '',
  };
}

function nextAction(issueStatus, latestRun, verification, statusConflict) {
  if (statusConflict) return 'Issue 与最新 Run 的终态不一致，建议先核对 Session，再决定是否重试。';
  if (issueStatus === 'triage') return '确认描述后移动到 Todo，runner 才会开始执行。';
  if (issueStatus === 'todo' && !latestRun) return '等待 runner claim；若长期未启动，请检查项目 loop。';
  if (issueStatus === 'todo') return '当前已排队，等待下一轮 runner claim。';
  if (issueStatus === 'in_progress') return '任务正在执行，进入 Session 查看或补充实时上下文。';
  if (issueStatus === 'pending_verification') return '查看验证证据并完成 Accept / Reject / Request changes。';
  if (issueStatus === 'done' && verification.state !== 'recorded') return '补充结构化验证证据，避免只凭 done 状态判断完成。';
  if (issueStatus === 'failed' || issueStatus === 'cancelled') return '先查看最新 Run / Session 的退出原因，修复后重新执行。';
  return '查看活动记录，确认任务状态与执行结果。';
}

function latestEvent(events, type) {
  if (!Array.isArray(events)) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === type) return events[index];
  }
  return null;
}

function parsePayload(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const text = cleanText(value);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function terminalStatus(value) {
  const status = cleanText(value);
  return TERMINAL_STATUSES.has(status) ? status : '';
}

function cleanText(value) {
  return String(value ?? '').trim();
}
