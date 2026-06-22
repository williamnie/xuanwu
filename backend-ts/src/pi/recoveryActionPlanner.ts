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

const NEEDS_USER_ESCALATE = "needs_user.escalate";
const PROVIDER_RUNTIME_UNAVAILABLE = "provider_runtime_unavailable";
const MAX_ERROR_SUMMARY_LENGTH = 160;

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
  return actionType === "" ? [] : [actionCandidate(input, actionType, classified)];
}

function actionCandidate(
  input: RecoveryActionPlanInput,
  actionType: string,
  classified: { failure_class: RecoveryFailureClass; reason: string }
): Record<string, unknown> {
  return compact({
    action_type: actionType,
    gate_policy: gatePolicy(input, actionType, classified.failure_class),
    issue_id: input.issueID,
    payload: actionPayload(input, actionType, classified.reason, classified.failure_class),
    project_id: input.projectID,
    rationale: reasonText(input.payload, classified.reason),
    requires_confirmation: actionType !== "issue.retry_after",
    risk_level: riskLevel(actionType)
  });
}

function actionPayload(
  input: RecoveryActionPlanInput,
  actionType: string,
  fallback: string,
  failureClass: RecoveryFailureClass
): Record<string, unknown> {
  const base = preconditionPayload(input, fallback);
  if (actionType === NEEDS_USER_ESCALATE) return {
    ...base,
    message: needsUserMessage(input, fallback, failureClass)
  };
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

function gatePolicy(
  input: RecoveryActionPlanInput,
  actionType: string,
  failureClass: RecoveryFailureClass
): Record<string, unknown> {
  const mode = clean(input.payload.supervisor_mode || input.payload.mode);
  const delegated = mode === "autonomous" || mode === "assisted";
  const allowed = stringList(input.payload.allowed_actions);
  const override = escalationOverride(input.payload, actionType, failureClass);
  const effectiveAllowed = override ? allowEscalation(allowed) : allowed;
  return compact({
    allowed_actions: delegated && effectiveAllowed.length === 0 ? ["__no_supervisor_actions_allowed__"] : effectiveAllowed,
    authorizedActions: effectiveAllowed.map((action_type) => ({
      action_type,
      issue_id: input.issueID,
      project_id: input.projectID
    })),
    budget_remaining: budgetRemaining(input.payload),
    cooldown_until: clean(input.payload.cooldown_until),
    hard_outage_escalation: override ? true : undefined,
    mode: delegated ? "delegated" : "manual",
    original_allowed_actions: override ? allowed : [],
    policy_override_reason: override ? overrideReason(input.payload, failureClass) : "",
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
    return NEEDS_USER_ESCALATE;
  }
  if (failureClass !== "transient") return "";
  if (shouldScheduleRetryAfter(payload)) return "issue.retry_after";
  if (clean(payload.retry_after_ready) === "true") return "issue.retry";
  return clean(payload.provider_session_id) !== "" ? "session.resume_followup" : "issue.retry";
}

function escalationOverride(
  payload: Record<string, unknown>,
  actionType: string,
  failureClass: RecoveryFailureClass
): boolean {
  if (actionType !== NEEDS_USER_ESCALATE) return false;
  return clean(payload.diagnosis_code) === PROVIDER_RUNTIME_UNAVAILABLE || failureClass === "exhausted";
}

function allowEscalation(allowed: string[]): string[] {
  return allowed.includes(NEEDS_USER_ESCALATE) ? allowed : [...allowed, NEEDS_USER_ESCALATE];
}

function overrideReason(payload: Record<string, unknown>, failureClass: RecoveryFailureClass): string {
  return clean(payload.diagnosis_code) === PROVIDER_RUNTIME_UNAVAILABLE
    ? "provider_runtime_unavailable_requires_user_escalation"
    : `${failureClass}_recovery_requires_user_escalation`;
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

function needsUserMessage(
  input: RecoveryActionPlanInput,
  fallback: string,
  failureClass: RecoveryFailureClass
): string {
  const diagnosis = clean(input.payload.diagnosis_code);
  if (diagnosis === PROVIDER_RUNTIME_UNAVAILABLE) return providerOutageMessage(input, fallback);
  if (failureClass === "exhausted") return exhaustedRecoveryMessage(input, fallback);
  return reasonText(input.payload, fallback);
}

function providerOutageMessage(input: RecoveryActionPlanInput, fallback: string): string {
  return "PI 判断 executor provider 当前不可用，无法继续自动恢复。" +
    `provider：${providerName(input.payload)}；issue id：${input.issueID}；` +
    `诊断码：${clean(input.payload.diagnosis_code)}；错误摘要：${errorSummary(input.payload, fallback)}。` +
    "请检查/重启 Codex app-server 或 Claude Code provider 后再 retry。";
}

function exhaustedRecoveryMessage(input: RecoveryActionPlanInput, fallback: string): string {
  return "PI 判断自动恢复预算或重试次数已耗尽，无法继续自动恢复。" +
    `provider：${providerName(input.payload)}；issue id：${input.issueID}；` +
    `诊断码：${clean(input.payload.diagnosis_code)}；错误摘要：${errorSummary(input.payload, fallback)}。` +
    "请检查 issue 状态、补充必要上下文或修复 provider 后再 retry。";
}

function providerName(payload: Record<string, unknown>): string {
  return clean(payload.provider) || "unknown";
}

function errorSummary(payload: Record<string, unknown>, fallback: string): string {
  const text = reasonText(payload, fallback).replace(/\s+/g, " ").trim();
  if (text.length <= MAX_ERROR_SUMMARY_LENGTH) return text;
  return `${text.slice(0, MAX_ERROR_SUMMARY_LENGTH)}…`;
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
