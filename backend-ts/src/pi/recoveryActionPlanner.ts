import {
  classifyRecoveryDiagnosis,
  type RecoveryFailureClass
} from "./recoveryDiagnosis.ts";

export type RecoveryActionPlanInput = {
  eventID: string;
  issueID: number;
  payload: Record<string, unknown>;
  projectID: string;
};

export function supervisorRecoveryActionCandidates(
  input: RecoveryActionPlanInput
): Array<Record<string, unknown>> {
  if (!isReadySupervisorCandidate(input.payload)) return [];
  if (!planningEnabled(input.payload)) return [];
  const classified = classifyRecoveryDiagnosis({
    diagnosisCode: clean(input.payload.diagnosis_code),
    providerErrorCategory: clean(input.payload.provider_error_category),
    status: clean(input.payload.status)
  });
  const actionType = recoveryActionType(classified.failure_class, input.payload);
  return actionType === "" ? [] : [actionCandidate(input, actionType, classified.reason)];
}

function actionCandidate(input: RecoveryActionPlanInput, actionType: string, fallback: string): Record<string, unknown> {
  return compact({
    action_type: actionType,
    gate_policy: gatePolicy(input),
    issue_id: input.issueID,
    payload: actionPayload(input, actionType, fallback),
    project_id: input.projectID,
    rationale: reasonText(input.payload, fallback),
    requires_confirmation: actionType !== "issue.retry_after",
    risk_level: riskLevel(actionType)
  });
}

function actionPayload(input: RecoveryActionPlanInput, actionType: string, fallback: string): Record<string, unknown> {
  const base = preconditionPayload(input, fallback);
  if (actionType === "needs_user.escalate") return { ...base, message: reasonText(input.payload, fallback) };
  if (actionType === "issue.retry_after") return {
    ...base,
    retry_after_at: clean(input.payload.wait_until) || clean(input.payload.retry_after_at)
  };
  if (actionType !== "session.resume_followup") return base;
  return {
    ...base,
    prompt: clean(input.payload.recovery_message) || defaultResumePrompt(input.payload, fallback),
    provider: clean(input.payload.provider) || "codex",
    provider_session_id: clean(input.payload.provider_session_id),
    provider_turn_id: clean(input.payload.provider_turn_id)
  };
}

function gatePolicy(input: RecoveryActionPlanInput): Record<string, unknown> {
  const mode = clean(input.payload.supervisor_mode || input.payload.mode);
  const delegated = mode === "autonomous" || mode === "assisted";
  const allowed = stringList(input.payload.allowed_actions);
  return compact({
    allowed_actions: delegated && allowed.length === 0 ? ["__no_supervisor_actions_allowed__"] : allowed,
    authorizedActions: allowed.map((action_type) => ({ action_type, issue_id: input.issueID, project_id: input.projectID })),
    budget_remaining: budgetRemaining(input.payload),
    cooldown_until: clean(input.payload.cooldown_until),
    mode: delegated ? "delegated" : "manual",
    recovery_gate: recoveryGate(input.payload),
    scope: { project_id: input.projectID }
  });
}

function preconditionPayload(input: RecoveryActionPlanInput, fallback: string): Record<string, unknown> {
  return compact({
    decision_id: `guardian:${input.eventID}`,
    diagnosis_code: clean(input.payload.diagnosis_code),
    expected_issue_status: clean(input.payload.issue_status || input.payload.expected_issue_status),
    expected_issue_updated_at: clean(input.payload.issue_updated_at || input.payload.expected_issue_updated_at),
    expected_provider_session_id: clean(input.payload.provider_session_id || input.payload.expected_provider_session_id),
    expected_provider_turn_id: clean(input.payload.provider_turn_id || input.payload.expected_provider_turn_id),
    expected_run_ended_at: clean(input.payload.run_ended_at || input.payload.expected_run_ended_at),
    expected_run_id: clean(input.payload.run_id || input.payload.expected_run_id),
    expected_run_status: clean(input.payload.run_status || input.payload.expected_run_status),
    expected_session_status: clean(input.payload.session_status || input.payload.expected_session_status),
    expected_session_turn_id: clean(input.payload.session_turn_id || input.payload.provider_turn_id),
    expected_session_updated_at: clean(input.payload.session_updated_at || input.payload.expected_session_updated_at),
    issue_id: input.issueID,
    reason: reasonText(input.payload, fallback)
  });
}

function recoveryActionType(failureClass: RecoveryFailureClass, payload: Record<string, unknown>): string {
  if (failureClass === "needs_context" || failureClass === "unsafe" || failureClass === "exhausted") {
    return "needs_user.escalate";
  }
  if (failureClass !== "transient") return "";
  if (shouldScheduleRetryAfter(payload)) return "issue.retry_after";
  if (clean(payload.retry_after_ready) === "true") return "issue.retry";
  return clean(payload.provider_session_id) !== "" ? "session.resume_followup" : "issue.retry";
}

function isReadySupervisorCandidate(payload: Record<string, unknown>): boolean {
  return clean(payload.signal_type) === "supervisor.candidate" && payload.ready !== false;
}

function planningEnabled(payload: Record<string, unknown>): boolean {
  return stringList(payload.allowed_actions).length > 0 || clean(payload.supervisor_mode || payload.mode) !== "";
}

function recoveryGate(payload: Record<string, unknown>): Record<string, unknown> {
  return compact({ budget_remaining: budgetRemaining(payload), cooldown_until: clean(payload.cooldown_until) });
}

function budgetRemaining(payload: Record<string, unknown>): number | undefined {
  const values = [numberValue(payload.budget_remaining), numberValue(payload.project_budget_remaining)]
    .filter((value) => value !== undefined) as number[];
  return values.length === 0 ? undefined : Math.min(...values);
}

function riskLevel(actionType: string): string {
  if (actionType === "session.steer") return "high";
  return actionType === "issue.retry_after" ? "low" : "medium";
}

function shouldScheduleRetryAfter(payload: Record<string, unknown>): boolean {
  const diagnosis = clean(payload.diagnosis_code);
  if (diagnosis === "provider_retry_after_waiting") return true;
  return diagnosis !== "provider_retry_after_ready" &&
    (clean(payload.wait_until) !== "" || clean(payload.retry_after_at) !== "");
}

function reasonText(payload: Record<string, unknown>, fallback: string): string {
  return clean(payload.reason) || clean(payload.rationale) || clean(payload.message) || fallback || "supervisor recovery candidate";
}

function defaultResumePrompt(payload: Record<string, unknown>, fallback: string): string {
  return `继续。请先检查当前 issue/session 状态，避免重复工作，然后只恢复未完成部分。原因：${reasonText(payload, fallback)}`;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  const text = clean(value);
  if (text === "") return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed.map(clean).filter(Boolean);
  } catch {}
  return text.split(/\n|,/).map(clean).filter(Boolean);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => (
    value !== "" && value !== undefined && (!Array.isArray(value) || value.length > 0)
  )));
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
