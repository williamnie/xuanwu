const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled']);

export function deriveIssueExecutionSummary({ issue = {}, runs = [] } = {}) {
  const latestRun = latestRunFromList(runs) || issue.latest_run || null;
  const issueStatus = cleanText(issue.status) || 'unknown';
  const runStatus = cleanText(latestRun?.status) || '';
  const awaitingPi = issueStatus === 'in_progress' && Boolean(latestRun?.ended_at);
  const piDecision = piDecisionSummary(issue, awaitingPi);
  const statusConflict = terminalStatus(issueStatus)
    && Boolean(latestRun)
    && !cleanText(latestRun?.ended_at)
    && ['created', 'running', 'recovering', 'in_progress'].includes(runStatus);

  return {
    issueStatus,
    awaitingPi,
    latestRun,
    runStatus,
    statusConflict: Boolean(statusConflict),
    piDecision,
    nextAction: nextAction(issueStatus, latestRun, Boolean(statusConflict), awaitingPi),
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

function piDecisionSummary(issue, awaitingPi) {
  const decision = issue?.decision || {};
  const phase = cleanText(decision.phase);
  if (decision.owner === 'human') return {
    state: 'attention', label: 'PI 请求人工决定', detail: decision.request?.question || '请回答 PI 提出的具体问题。',
  };
  if (phase === 'pi_deciding') return {
    state: 'recorded', label: 'PI 正在判断', detail: 'PI 正在读取 Provider Session、命令结果和工作区事实。',
  };
  if (phase === 'pi_continuing') return {
    state: 'recorded', label: 'PI 已要求继续', detail: 'Provider 正在同一个 Session 的新 Turn 中完成剩余工作。',
  };
  if (phase === 'pi_error') return {
    state: 'attention', label: 'PI 本轮执行失败', detail: decision.activity?.error || '系统会重试 PI 判断，不会把运行错误写成 Issue 结论。',
  };
  if (awaitingPi || phase === 'pi_waiting' || phase === 'pi_queued') return {
    state: 'recorded', label: '等待 PI 判断', detail: 'Provider Turn 已结束；PI 将决定接受、继续、重试或请求人工处理。',
  };
  if (phase === 'complete') return {
    state: 'recorded', label: `PI 已决定：${cleanText(issue.status)}`, detail: cleanText(issue.error) || 'Issue 终态由 PI 写入。',
  };
  return { state: 'missing', label: 'Provider 正在执行', detail: 'Provider Turn 结束后，PI 会读取真实上下文并作出结论。' };
}

function nextAction(issueStatus, latestRun, statusConflict, awaitingPi) {
  if (statusConflict) return 'Issue 已是终态，但最新 Run 仍未结束；建议先核对 Session 和运行态。';
  if (issueStatus === 'triage') return '确认描述后移动到 Todo，runner 才会开始执行。';
  if (issueStatus === 'todo' && !latestRun) return '等待 runner claim；若长期未启动，请检查项目 loop。';
  if (issueStatus === 'todo') return '当前已排队，等待下一轮 runner claim。';
  if (awaitingPi) return 'Provider Turn 已结束，PI 正在读取 Session 上下文并决定接受、继续、重试或请求用户处理。';
  if (issueStatus === 'in_progress') return 'Provider 正在执行，进入 Session 查看实时上下文。';
  if (issueStatus === 'needs_user') return 'PI 已明确提出需要你决定的问题；处理后会回到同一个 Issue。';
  if (issueStatus === 'failed' || issueStatus === 'cancelled') return '先查看最新 Run / Session 的退出原因，修复后重新执行。';
  return '查看活动记录，确认任务状态与执行结果。';
}

function terminalStatus(value) {
  const status = cleanText(value);
  return TERMINAL_STATUSES.has(status) ? status : '';
}

function cleanText(value) {
  return String(value ?? '').trim();
}
