import { issueRunSessionRef } from '../../utils/issueRuns';

const ACTIVE_SUPERVISOR_STATUSES = new Set(['todo', 'in_progress']);

export function providerLabel(provider) {
  switch (String(provider || 'codex').toLowerCase()) {
    case 'codex':
      return 'Codex';
    case 'claude':
      return 'Claude';
    case 'opencode':
      return 'opencode';
    case 'kimicode':
      return 'kimicode';
    default:
      return provider || 'Unknown';
  }
}

export function issueProviderIdentity(issue, runs) {
  const latestRun = [...(runs || [])].reverse().find(run =>
    run?.provider || run?.provider_session_id || run?.provider_turn_id
  );
  return {
    provider: latestRun?.provider || 'codex',
    sessionId: latestRun?.provider_session_id || issue?.codex_thread_id || '',
    turnId: latestRun?.provider_turn_id || issue?.codex_turn_id || '',
  };
}

export function issueExecutionSessionRef(issue, latestRun, runtimeIdentity) {
  if (latestRun) return issueRunSessionRef(issue, latestRun);
  return runtimeIdentity.sessionId ? `codex:${runtimeIdentity.sessionId}` : '';
}

export function formatDateTime(value) {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function summarize(value, maxLength) {
  if (!value || value.length <= maxLength) return value || '';
  return `${value.slice(0, maxLength - 1)}…`;
}

export function issueSourceSessionRef(issue) {
  const sessionId = String(issue?.source_session_id || '').trim();
  if (!sessionId) return '';
  return sessionId.startsWith('codex:') ? sessionId : `codex:${sessionId}`;
}

export function canGenerateVerifierReport(issue) {
  if (issue?.status === 'pending_verification') return true;
  return issue?.status === 'done' && String(issue?.error || '').trim() !== '';
}

export function issueVerifierReports(events = []) {
  return events
    .filter(event => event.type === 'issue.verification_report')
    .map(event => ({ event, report: parseVerifierReportPayload(event.payload) }))
    .filter(item => item.report.summary || item.report.recommendation)
    .reverse();
}

function parseVerifierReportPayload(rawPayload) {
  let payload = rawPayload || {};
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = {};
    }
  }
  return {
    summary: payload.summary || '',
    acceptanceChecklist: payload.acceptanceChecklist || payload.acceptance_checklist || '',
    evidenceFound: payload.evidenceFound || payload.evidence_found || '',
    evidenceMissing: payload.evidenceMissing || payload.evidence_missing || '',
    risk: payload.risk || '',
    recommendation: payload.recommendation || '',
    threadId: payload.thread_id || payload.threadId || '',
    turnId: payload.turn_id || payload.turnId || '',
  };
}

export function supervisorHasSignal(supervisor) {
  const latest = supervisor?.latest || {};
  const decision = latest.pi_decision || {};
  return Boolean(
    latest.diagnosis_code
      || decision.decision
      || supervisor?.retry_after
      || latest.provider_error?.raw_summary
      || (Array.isArray(supervisor?.recovery_history) && supervisor.recovery_history.length > 0)
  );
}

export function supervisorNeedsAttention(supervisor, issue) {
  if (!ACTIVE_SUPERVISOR_STATUSES.has(issue?.status)) return false;
  const latest = supervisor?.latest || {};
  const decision = latest.pi_decision?.decision || '';
  const diagnosis = String(latest.diagnosis_code || '');
  return decision === 'needs_user'
    || decision === 'blocked'
    || Number(supervisor?.retry_after?.remaining_seconds || 0) > 0
    || diagnosis === 'provider_retry_after_waiting';
}

export function issuePriorityLabel(value) {
  const priority = Number(value);
  if (priority === 2) return 'High · 紧急';
  if (priority === 1) return 'Medium · 普通';
  if (priority === 0) return 'Low · 低';
  return Number.isFinite(priority) ? `Legacy rank · ${priority}` : '未设置';
}

export function issueStatusDescription(status) {
  switch (status) {
    case 'triage': return '待梳理任务说明，尚未进入 runner 队列。';
    case 'todo': return '已进入执行队列，等待 runner claim。';
    case 'in_progress': return 'Provider 正在执行，实时交互请进入 Session。';
    case 'pending_verification': return '执行已结束，等待人工完成验证门禁。';
    case 'done': return '任务已结束；请结合 Run 与结构化验证证据判断结果。';
    case 'failed': return '最近一次执行失败，可从日志或 Session 定位退出原因。';
    case 'cancelled': return '任务已取消，可在确认上下文后重新执行。';
    default: return '查看活动记录和运行信息确认当前状态。';
  }
}

export function formatRelativeTime(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return '未知时间';
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.max(1, Math.floor(delta / 60_000))} 分钟前`;
  if (delta < 86_400_000) return `${Math.max(1, Math.floor(delta / 3_600_000))} 小时前`;
  return `${Math.max(1, Math.floor(delta / 86_400_000))} 天前`;
}

export function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!ok) throw new Error('当前浏览器不支持复制到剪贴板');
  return Promise.resolve();
}
