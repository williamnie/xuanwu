import type { RunnerDatabase } from "../db/database.ts";
import { createIssueSupervisorEvent } from "../db/repositories/pi.ts";
import {
  guardianSignalsFromSupervisorCandidates,
  writeGuardianSignals
} from "../pi/guardianSignals.ts";
import { iso } from "../pi/heartbeatOrchestratorSupport.ts";
import type { IssueSupervisorRecoveryContext } from "../pi/issueSupervisorContext.ts";

export type SupervisorBudgetTarget = {
  candidate: IssueSupervisorRecoveryContext["candidates"][number];
  context: IssueSupervisorRecoveryContext;
  issueID: number;
  projectID: string;
};

export function recordBudgetExhaustedEscalation(
  db: RunnerDatabase,
  target: SupervisorBudgetTarget,
  now: Date
): void {
  const payload = budgetPayload(target);
  createIssueSupervisorEvent(db, {
    action_type: "needs_user.escalate",
    decision: "needs_user",
    diagnosis_code: clean(target.candidate.diagnosis_code),
    event_type: "budget_exhausted",
    issue_id: target.issueID,
    payload_json: payload,
    project_id: target.projectID,
    provider: sessionProvider(target),
    provider_error_category: clean(target.context.provider_error?.category),
    provider_session_id: clean(target.context.session.provider_session_id),
    provider_turn_id: clean(target.context.session.provider_turn_id),
    run_id: clean(target.context.latest_run?.id)
  });
  writeGuardianSignals(db, guardianSignalsFromSupervisorCandidates([guardianPayload(target, payload)], {
    heartbeatID: `supervisor-budget:${target.projectID}:${target.issueID}:${iso(now)}`,
    now,
    projectID: target.projectID
  }));
}

function guardianPayload(target: SupervisorBudgetTarget, payload: Record<string, unknown>) {
  return {
    allowed_actions: ["needs_user.escalate"],
    budget_remaining: 0,
    cooldown_until: "",
    diagnosis_code: clean(target.candidate.diagnosis_code),
    evidence_refs: target.candidate.evidence_refs ?? [],
    issue_status: clean(target.context.issue.status),
    issue_updated_at: clean(target.context.issue.updated_at),
    issue_id: target.issueID,
    project_id: target.projectID,
    project_budget_remaining: numberValue(target.context.policy.project_budget_remaining),
    provider: sessionProvider(target),
    provider_error_category: clean(target.context.provider_error?.category),
    provider_session_id: clean(target.context.session.provider_session_id),
    provider_turn_id: clean(target.context.session.provider_turn_id),
    ready: true,
    reason: target.candidate.reason,
    run_ended_at: clean(target.context.latest_run?.ended_at),
    run_id: clean(target.context.latest_run?.id),
    run_status: clean(target.context.latest_run?.status),
    session_status: clean(target.context.session.raw_status),
    session_turn_id: clean(target.context.session.provider_turn_id),
    session_updated_at: clean(target.context.session.updated_at),
    stale_gap_seconds: numberValue(target.context.session.stale_gap_seconds),
    wait_until: "",
    ...payload
  };
}

function budgetPayload(target: SupervisorBudgetTarget): Record<string, unknown> {
  const history = target.context.recovery_history;
  return {
    attempts_24h: numberValue(history.attempts_24h),
    budget_status: clean(history.budget_status),
    count: budgetCount(history),
    diagnosis_code: clean(target.candidate.diagnosis_code),
    evidence_refs: target.candidate.evidence_refs ?? [],
    issue_id: target.issueID,
    last_action_at: clean(history.last_action_at),
    last_action_status: clean(history.last_action_status),
    last_action_type: clean(history.last_action_type),
    last_recovery_attempt_id: clean(history.last_recovery_attempt_id),
    message: budgetMessage(target),
    outcome: "needs_user",
    project_id: target.projectID,
    project_attempts_1h: numberValue(history.project_attempts_1h),
    reason: target.candidate.reason,
    report_status: "budget_exhausted",
    session_resume_attempts_24h: numberValue(history.session_resume_attempts_24h),
    window: budgetWindowLabel(history),
    window_started_at: budgetWindowStartedAt(history)
  };
}

function budgetMessage(target: SupervisorBudgetTarget): string {
  const count = budgetCount(target.context.recovery_history);
  const last = clean(target.context.recovery_history.last_action_type) || "unknown";
  return `${target.candidate.reason}; issue=${target.issueID}; ` +
    `diagnosis=${target.candidate.diagnosis_code}; ` +
    `window=${budgetWindowLabel(target.context.recovery_history)}; count=${count}; last_action=${last}`;
}

function budgetCount(history: Record<string, unknown>): number {
  const status = clean(history.budget_status);
  if (status === "project_budget_exhausted") return numberValue(history.project_attempts_1h);
  if (status === "session_resume_exhausted") return numberValue(history.session_resume_attempts_24h);
  return numberValue(history.attempts_24h);
}

function budgetWindowStartedAt(history: Record<string, unknown>): string {
  return clean(history.budget_status) === "project_budget_exhausted"
    ? clean(history.project_window_started_at)
    : clean(history.budget_window_started_at);
}

function budgetWindowLabel(history: Record<string, unknown>): string {
  return clean(history.budget_status) === "project_budget_exhausted" ? "1h" : "24h";
}

function sessionProvider(target: SupervisorBudgetTarget): string {
  return clean(target.context.session.provider) || clean(target.context.provider_error?.provider);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
