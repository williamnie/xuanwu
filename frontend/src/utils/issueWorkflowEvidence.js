import {
  deriveTriageReadiness,
  issueRefinementReadiness,
  parseIssueRefinement,
} from './issueRefinement.js';
import {
  issueRunExitText,
  issueRunMetadata,
  issueRunSessionId,
  issueRunSessionRef,
  issueRunTurnId,
  latestIssueRun,
  providerLabel,
  shortId,
  summarize,
} from './issueRuns.js';
import { workflowFromSnapshot } from './issueWorkflowSnapshot.js';

const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled']);
const VERIFY_PATTERN = /verification|verified|verify|验收|验证|测试|test|tests|vitest|jest|node --test|go test|npm (?:run )?test|pnpm (?:exec )?vitest|build|lint/i;

export function deriveIssueWorkflowEvidence({ issue = {}, events = [], runs = [] } = {}) {
  const snapshotWorkflow = workflowFromSnapshot(issue.workflow_snapshot_json, issue, runs, workflowStep);
  if (snapshotWorkflow) {
    return snapshotWorkflow;
  }
  const parsed = parseIssueRefinement(issue.description);
  const refinement = parsed.refinement;
  const readiness = issueRefinementReadiness(refinement);
  const triageReadiness = deriveTriageReadiness({
    issue,
    refinement,
    commentEvents: events.filter(event => event.type === 'issue.comment'),
  });
  const latestRunInfo = normalizeLatestRun(issue, runs);
  const explicitFinalStatus = terminalStatus(latestFinalStatus(events) || issue.status);
  const verificationEvidence = findVerificationEvidence({ issue, events, latestRun: latestRunInfo });

  return {
    source: 'derived',
    latestRun: latestRunInfo,
    explicitFinalStatus,
    verificationEvidence,
    nextAction: workflowNextAction(issue, readiness, latestRunInfo, explicitFinalStatus, verificationEvidence),
    steps: [
      intakeStep(issue, parsed.body, events),
      refineStep(refinement, readiness),
      readyStep(issue, readiness, triageReadiness),
      implementStep(issue, latestRunInfo),
      verifyStep(issue, latestRunInfo, explicitFinalStatus, verificationEvidence),
      closeStep(explicitFinalStatus, verificationEvidence),
    ],
  };
}

function intakeStep(issue, body, events) {
  const created = issue.created_at || findEvent(events, 'issue.created')?.created_at || '';
  const summary = body ? summarize(oneLine(body), 120) : 'raw description 为空';
  return workflowStep('intake', 'Intake', created || body ? 'done' : 'missing', summary, nextHint(created, 'issue.created 未记录'));
}

function refineStep(refinement, readiness) {
  if (readiness.ready) {
    return workflowStep('refine', 'Refine', 'done', 'Refinement block 已包含验收与验证字段。');
  }
  if (hasAnyRefinement(refinement)) {
    return workflowStep('refine', 'Refine', 'warning', `Refinement 未完整，缺少：${readiness.missing.join('、')}。`);
  }
  return workflowStep('refine', 'Refine', 'missing', '未找到 refinement block 或有效字段。');
}

function readyStep(issue, readiness, triageReadiness) {
  if (readiness.ready) {
    return workflowStep('ready', 'Ready', 'done', 'Acceptance criteria 与 Verification plan 可用于验收。');
  }
  if (issue.status !== 'triage') {
    return workflowStep('ready', 'Ready', 'warning', `Issue 已进入 ${issue.status}，但仍缺：${readiness.missing.join('、')}。`);
  }
  return workflowStep('ready', 'Ready', 'missing', triageReadiness?.source || 'Triage readiness 未满足。');
}

function implementStep(issue, latestRunInfo) {
  if (!latestRunInfo) {
    const state = issue.status === 'failed' || issue.status === 'done' ? 'missing' : 'pending';
    return workflowStep('implement', 'Implement', state, '暂无 issue_runs 记录。');
  }
  const evidence = latestRunEvidence(latestRunInfo);
  if (latestRunInfo.status === 'in_progress' || issue.status === 'in_progress') {
    return workflowStep('implement', 'Implement', 'active', evidence);
  }
  if (latestRunInfo.status === 'failed') {
    return workflowStep('implement', 'Implement', 'blocked', evidence);
  }
  if (latestRunInfo.status === 'cancelled') {
    return workflowStep('implement', 'Implement', 'warning', evidence);
  }
  return workflowStep('implement', 'Implement', 'done', evidence);
}

function verifyStep(issue, latestRunInfo, explicitFinalStatus, verificationEvidence) {
  const runError = latestRunInfo?.error || issue.error || '';
  if (explicitFinalStatus === 'failed' || runError) {
    return workflowStep('verify', 'Verify', 'blocked', verifyEvidenceText(verificationEvidence, runError));
  }
  if (explicitFinalStatus === 'cancelled') {
    return workflowStep('verify', 'Verify', 'warning', verifyEvidenceText(verificationEvidence, 'Issue 已取消，未完成验收。'));
  }
  if (verificationEvidence.found) {
    return workflowStep('verify', 'Verify', 'done', verificationEvidence.summary);
  }
  if (explicitFinalStatus === 'done') {
    return workflowStep('verify', 'Verify', 'warning', '未找到 verification evidence；不能仅因 status=done 判定验收充分。');
  }
  return workflowStep('verify', 'Verify', 'missing', '未找到 verification evidence。');
}

function closeStep(explicitFinalStatus, verificationEvidence) {
  if (explicitFinalStatus === 'done') {
    const state = verificationEvidence.found ? 'done' : 'warning';
    return workflowStep('close', 'Close', state, 'Explicit final status: done');
  }
  if (explicitFinalStatus === 'failed') {
    return workflowStep('close', 'Close', 'blocked', 'Explicit final status: failed');
  }
  if (explicitFinalStatus === 'cancelled') {
    return workflowStep('close', 'Close', 'warning', 'Explicit final status: cancelled');
  }
  return workflowStep('close', 'Close', 'pending', '尚未显式回写 done / failed / cancelled。');
}

function workflowStep(id, label, state, evidence, hint = '') {
  return { id, label, state, evidence: summarize(String(evidence || ''), 200), hint };
}

function normalizeLatestRun(issue, runs) {
  const run = latestRunFromList(runs) || latestIssueRun(issue);
  if (!run) return null;
  return {
    ...run,
    providerLabel: providerLabel(run.provider),
    sessionId: issueRunSessionId(issue, run),
    turnId: issueRunTurnId(issue, run),
    sessionRef: issueRunSessionRef(issue, run),
    exitText: issueRunExitText(run),
    metadata: issueRunMetadata(run),
  };
}

function latestRunFromList(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return null;
  return runs.reduce((latest, run) => {
    if (!latest) return run;
    if (Number(run.attempt || 0) !== Number(latest.attempt || 0)) {
      return Number(run.attempt || 0) > Number(latest.attempt || 0) ? run : latest;
    }
    return String(run.started_at || '') >= String(latest.started_at || '') ? run : latest;
  }, null);
}

function latestRunEvidence(run) {
  const ids = [run.sessionId ? `Session ${shortId(run.sessionId)}` : '', run.turnId ? `Turn ${shortId(run.turnId)}` : '']
    .filter(Boolean).join(' / ');
  return [`Attempt #${run.attempt || '?'}`, run.status || 'unknown', ids, run.exitText].filter(Boolean).join(' · ');
}

function findVerificationEvidence({ issue, events, latestRun }) {
  const candidates = evidenceCandidates(issue, events, latestRun);
  const verified = candidates.find(item => item.kind === 'verification');
  const failure = candidates.find(item => item.kind === 'failure');
  const fallback = verified || failure;
  return {
    found: Boolean(fallback),
    summary: fallback ? summarize(fallback.text, 200) : '未找到 verification evidence',
    source: fallback?.source || '',
  };
}

function evidenceCandidates(issue, events, latestRun) {
  const candidates = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const payload = parseEventPayload(event);
    const text = eventEvidenceText(event, payload);
    if (!text) continue;
    if (event.type === 'issue.error' || event.type === 'issue.notification_failed') {
      candidates.push({ kind: 'failure', text, source: event.type });
      continue;
    }
    if (VERIFY_PATTERN.test(text)) {
      candidates.push({ kind: 'verification', text, source: event.type });
    }
  }
  for (const text of [issue.error, latestRun?.error]) {
    if (!text) continue;
    candidates.push({ kind: VERIFY_PATTERN.test(text) ? 'verification' : 'failure', text, source: 'error' });
  }
  return candidates;
}

function eventEvidenceText(event, payload) {
  const text = firstNonEmpty(event.error, event.text, payload.error, payload.text, payload.body, payload.message, payload.command);
  return summarize(oneLine(text), 240);
}

function verifyEvidenceText(verificationEvidence, fallback) {
  if (verificationEvidence.found) return verificationEvidence.summary;
  return summarize(firstNonEmpty(fallback, '未找到 verification evidence'), 200);
}

function latestFinalStatus(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== 'issue.status_changed') continue;
    const payload = parseEventPayload(event);
    const status = terminalStatus(event.status || payload.status);
    if (status) return status;
  }
  return '';
}

function workflowNextAction(issue, readiness, latestRunInfo, explicitFinalStatus, verificationEvidence) {
  if (!readiness.ready) return `补齐 ${readiness.missing.join('、')} 后再执行。`;
  if (!latestRunInfo && issue.status === 'todo') return '等待 runner claim，或检查项目 loop 是否已启动。';
  if (issue.status === 'in_progress') return '等待 latest run 结束，并确认 agent 显式回写最终状态。';
  if (explicitFinalStatus === 'done' && !verificationEvidence.found) return '补充测试/验证摘要，避免只凭 done 状态验收。';
  if (explicitFinalStatus === 'failed' || explicitFinalStatus === 'cancelled') return '查看 latest run/error 摘要，修复后 Retry。';
  if (!explicitFinalStatus) return '执行完成后按契约显式回写 done / failed。';
  return '证据已可用于人工验收。';
}

function findEvent(events, type) {
  return events.find(event => event.type === type);
}

function terminalStatus(status) {
  const value = String(status || '').trim();
  return TERMINAL_STATUSES.has(value) ? value : '';
}

function parseEventPayload(event) {
  if (!event?.payload) return {};
  if (typeof event.payload !== 'string') return event.payload;
  try {
    return JSON.parse(event.payload);
  } catch {
    return { text: event.payload };
  }
}

function hasAnyRefinement(refinement) {
  return Object.values(refinement || {}).some(value => String(value || '').trim());
}

function nextHint(value, fallback) {
  return value || fallback;
}

function firstNonEmpty(...values) {
  return values.find(value => String(value || '').trim()) || '';
}

function oneLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
