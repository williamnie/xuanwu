import {
  issueRunExitText,
  issueRunMetadata,
  issueRunSessionId,
  issueRunSessionRef,
  issueRunTurnId,
  latestIssueRun,
  providerLabel,
} from './issueRuns.js';

export function workflowFromSnapshot(raw, issue = {}, runs = [], workflowStep) {
  const snapshot = parseWorkflowSnapshot(raw);
  if (!snapshot) return null;
  const steps = snapshot.steps.map(step => snapshotStep(step, workflowStep));
  const currentStepId = cleanText(snapshot.current_step_id);
  return {
    source: 'snapshot',
    currentStepId,
    latestRun: snapshotLatestRun(snapshot, issue, runs),
    explicitFinalStatus: '',
    verificationEvidence: snapshotVerificationEvidence(steps),
    nextAction: snapshotNextAction(currentStepId, steps),
    steps,
  };
}

function parseWorkflowSnapshot(raw) {
  if (!cleanText(raw)) return null;
  try {
    const snapshot = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(snapshot?.steps) ? snapshot : null;
  } catch {
    return null;
  }
}

function snapshotStep(step, workflowStep) {
  return workflowStep(
    cleanText(step?.id),
    cleanText(step?.label) || cleanText(step?.id),
    snapshotStepState(step?.status),
    cleanText(step?.evidence_summary) || '暂无 snapshot evidence',
    snapshotStepHint(step),
  );
}

function snapshotStepState(status) {
  const value = cleanText(status);
  if (['active', 'done', 'blocked', 'warning', 'missing'].includes(value)) {
    return value;
  }
  return 'pending';
}

function snapshotStepHint(step) {
  return [cleanText(step?.actor), cleanText(step?.updated_at)].filter(Boolean).join(' · ');
}

function snapshotVerificationEvidence(steps) {
  const verify = steps.find(step => step.id === 'verify');
  const found = Boolean(verify?.evidence && verify.evidence !== '暂无 snapshot evidence');
  return {
    found,
    summary: found ? verify.evidence : '未找到 verification evidence',
    source: found ? 'workflow_snapshot' : '',
  };
}

function snapshotNextAction(currentStepId, steps) {
  const current = steps.find(step => step.id === currentStepId);
  if (current) return `当前 workflow step: ${current.label} (${current.state})`;
  return '使用 workflow snapshot 展示；等待后续状态更新。';
}

function snapshotLatestRun(snapshot, issue, runs) {
  const snapshotIssue = issueFromSnapshot(snapshot);
  return normalizeLatestRun({
    ...snapshotIssue,
    ...issue,
    latest_run: issue?.latest_run || snapshotIssue.latest_run,
  }, runs);
}

function issueFromSnapshot(snapshot) {
  return {
    latest_run: snapshot?.latest_run || snapshot?.latestRun,
    codex_thread_id: snapshot?.codex_thread_id || snapshot?.codexThreadId,
    codex_turn_id: snapshot?.codex_turn_id || snapshot?.codexTurnId,
  };
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

function cleanText(value) {
  return String(value || '').trim();
}
