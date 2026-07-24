import { getPiAction, updatePiAction, createIssueSupervisorEvent, type PiAction } from "../db/repositories/pi.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { dispatchPiAction } from "../http/piActionDispatch.ts";
import { createPendingPiAction, recordPiActionAuditEvent, type PiActionRequest } from "./actionEngine.ts";
import type { PiGatePolicy } from "./actionGate.ts";
import type { IssueSupervisorRecoveryContext } from "./issueSupervisorContext.ts";
import {
  PI_SUPERVISOR_DECISION_ACTION_TYPES,
  PI_SUPERVISOR_DECISIONS,
  type PiSupervisorDecisionJson
} from "./issueSupervisorRecovery.ts";
import { recordSupervisorRecoveryAttempt } from "./issueSupervisorRecoveryAttemptRecorder.ts";

export type IssueSupervisorActionInput = {
  context: IssueSupervisorRecoveryContext;
  database: RunnerDatabase;
  decision: PiSupervisorDecisionJson;
  now?: Date;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  recordDecision?: boolean;
};

export type IssueSupervisorActionSummary = {
  action_id: string;
  action_type: string;
  decision: string;
  status: string;
};

export type IssueSupervisorActionResult = {
  actions: IssueSupervisorActionSummary[];
  executed_actions: string[];
};

export async function applyIssueSupervisorDecisionActions(
  input: IssueSupervisorActionInput
): Promise<IssueSupervisorActionResult> {
  if (input.recordDecision !== false) recordDecisionEvent(input);
  const requests = actionRequests(input);
  const actions: IssueSupervisorActionSummary[] = [];
  const executed: string[] = [];
  for (const request of requests) {
    const summary = createPendingPiAction(input.database, {
      authorization: supervisorGatePolicy(input),
      source: "pi_supervisor"
    }, request) as IssueSupervisorActionSummary;
    recordActionEvent(input, summary);
    const final = await executeIfApproved(input, summary.action_id);
    actions.push(final);
    if (final.status === "completed") executed.push(final.action_id);
  }
  return { actions, executed_actions: executed };
}

function actionRequests(input: IssueSupervisorActionInput): PiActionRequest[] {
  return actionTypes(input.decision).map((actionType) => ({
    actionType,
    issueID: issueID(input.context),
    payload: actionPayload(input, actionType),
    projectID: projectID(input.context),
    rationale: input.decision.rationale
  }));
}

function actionTypes(decision: PiSupervisorDecisionJson): string[] {
  const key = clean(decision.decision);
  return isSupervisorDecision(key) ? PI_SUPERVISOR_DECISION_ACTION_TYPES[key] : ["issue.supervisor_decision"];
}

function isSupervisorDecision(value: string): value is keyof typeof PI_SUPERVISOR_DECISION_ACTION_TYPES {
  return (PI_SUPERVISOR_DECISIONS as readonly string[]).includes(value);
}

function actionPayload(input: IssueSupervisorActionInput, actionType: string): Record<string, unknown> {
  if (actionType === "session.resume_followup") return { ...sessionPayload(input), prompt: requiredRecoveryMessage(input) };
  if (actionType === "session.steer") return { ...sessionPayload(input), prompt: requiredRecoveryMessage(input) };
  if (actionType === "issue.retry_after") {
    return { ...preconditionPayload(input), reason: primaryDiagnosis(input.context), retry_after_at: waitUntil(input) };
  }
  if (actionType === "issue.supervisor_decision") return { ...preconditionPayload(input), decision: input.decision };
  if (actionType === "needs_user.escalate") {
    return { ...preconditionPayload(input), message: requiredRecoveryMessage(input) || input.decision.rationale };
  }
  return { ...preconditionPayload(input), reason: input.decision.rationale };
}

function preconditionPayload(input: IssueSupervisorActionInput): Record<string, unknown> {
  const context = input.context;
  return compact({
    decision_id: decisionID(input),
    diagnosis_code: primaryDiagnosis(context),
    expected_issue_status: clean(context.issue.status),
    expected_issue_updated_at: clean(context.issue.updated_at),
    expected_provider_session_id: clean(context.latest_run?.provider_session_id),
    expected_provider_turn_id: clean(context.latest_run?.provider_turn_id),
    expected_run_ended_at: clean(context.latest_run?.ended_at),
    expected_run_id: clean(context.latest_run?.id),
    expected_run_status: clean(context.latest_run?.status),
    expected_session_status: clean(context.session.raw_status),
    expected_session_turn_id: clean(context.session.provider_turn_id),
    expected_session_updated_at: clean(context.session.updated_at),
    issue_id: issueID(context)
  });
}

function sessionPayload(input: IssueSupervisorActionInput): Record<string, unknown> {
  const context = input.context;
  return compact({
    ...preconditionPayload(input),
    provider: clean(context.session.provider) || clean(context.provider_error?.provider) || "codex",
    provider_session_id: clean(context.session.provider_session_id),
    provider_turn_id: clean(context.session.provider_turn_id)
  });
}

async function executeIfApproved(
  input: IssueSupervisorActionInput,
  actionID: string
): Promise<IssueSupervisorActionSummary> {
  const action = getPiAction(input.database, actionID);
  if (!action || action.gate_decision !== "execute" || action.status !== "approved") return actionSummary(action);
  const executing = updatePiAction(input.database, action.id, { status: "executing" });
  recordPiActionAuditEvent(input.database, executing, "execution_started", { actor: "gate", decision: "execute" });
  recordSupervisorRecoveryAttempt(input, executing);
  try {
    const result = await dispatchPiAction({ database: input.database, providers: input.providers }, executing);
    const completed = updatePiAction(input.database, action.id, { result_json: JSON.stringify(result ?? null), status: "completed" });
    recordPiActionAuditEvent(input.database, completed, "execution_result", { actor: "executor", result });
    return actionSummary(completed);
  } catch (error) {
    const failed = updatePiAction(input.database, action.id, { result_json: JSON.stringify({ error: safeError(error) }), status: "failed" });
    recordPiActionAuditEvent(input.database, failed, "execution_error", { actor: "executor", error: safeError(error) });
    recordResultEvent(input, failed, { error: safeError(error), outcome: "failed" });
    return actionSummary(failed);
  }
}

function supervisorGatePolicy(input: IssueSupervisorActionInput): PiGatePolicy {
  const configured = stringArray(input.context.policy.allowed_actions);
  const allowed = [...new Set([...configured, "issue.supervisor_decision"])];
  const autonomous = clean(input.context.policy.mode) === "autonomous";
  const allowedActions = autonomous && configured.length === 0
    ? ["issue.supervisor_decision"]
    : allowed;
  return compact({
    allowed_actions: allowedActions,
    authorizedActions: allowed.map((action_type) => ({ action_type, issue_id: issueID(input.context), project_id: projectID(input.context) })),
    budget_remaining: budgetRemaining(input.context),
    cooldown_until: cooldownUntil(input),
    mode: autonomous ? "delegated" : "manual",
    now: (input.now ?? new Date()).toISOString(),
    scope: { project_id: projectID(input.context) }
  }) as PiGatePolicy;
}

function recordDecisionEvent(input: IssueSupervisorActionInput): void {
  createIssueSupervisorEvent(input.database, {
    confidence: input.decision.confidence,
    decision: input.decision.decision,
    diagnosis_code: primaryDiagnosis(input.context),
    event_type: "decision",
    issue_id: issueID(input.context),
    payload_json: { decision: input.decision },
    project_id: projectID(input.context),
    provider: clean(input.context.session.provider) || clean(input.context.provider_error?.provider),
    provider_error_category: clean(input.context.provider_error?.category),
    provider_session_id: clean(input.context.session.provider_session_id),
    provider_turn_id: clean(input.context.session.provider_turn_id),
    retry_after_at: waitUntil(input),
    run_id: clean(input.context.latest_run?.id)
  });
}

function recordActionEvent(input: IssueSupervisorActionInput, action: IssueSupervisorActionSummary): void {
  createIssueSupervisorEvent(input.database, {
    action_id: action.action_id,
    action_type: action.action_type,
    decision: input.decision.decision,
    diagnosis_code: primaryDiagnosis(input.context),
    event_type: "action",
    issue_id: issueID(input.context),
    payload_json: action,
    project_id: projectID(input.context)
  });
}

function recordResultEvent(input: IssueSupervisorActionInput, action: PiAction, result: Record<string, unknown>): void {
  createIssueSupervisorEvent(input.database, {
    action_id: action.id,
    action_type: action.action_type,
    decision: input.decision.decision,
    diagnosis_code: primaryDiagnosis(input.context),
    event_type: "result",
    issue_id: action.issue_id,
    payload_json: result,
    project_id: action.project_id,
    provider: clean(input.context.session.provider) || clean(input.context.provider_error?.provider),
    provider_session_id: clean(input.context.session.provider_session_id),
    provider_turn_id: clean(input.context.session.provider_turn_id),
    run_id: clean(input.context.latest_run?.id)
  });
}

function actionSummary(action: PiAction | null): IssueSupervisorActionSummary {
  return {
    action_id: action?.id ?? "",
    action_type: action?.action_type ?? "",
    decision: action?.gate_decision ?? "",
    status: action?.status ?? ""
  };
}

function budgetRemaining(context: IssueSupervisorRecoveryContext): number | undefined {
  const values = [numberValue(context.policy.budget_remaining), numberValue(context.policy.project_budget_remaining)]
    .filter((value) => value !== undefined) as number[];
  return values.length === 0 ? undefined : Math.min(...values);
}

function cooldownUntil(input: IssueSupervisorActionInput): string {
  const last = Date.parse(clean(input.context.recovery_history.last_action_at));
  const seconds = numberValue(input.context.policy.cooldown_seconds) ?? 0;
  if (!Number.isFinite(last) || seconds <= 0) return "";
  const until = new Date(last + seconds * 1_000);
  return until.getTime() > (input.now ?? new Date()).getTime() ? until.toISOString() : "";
}

function waitUntil(input: IssueSupervisorActionInput): string {
  return clean(input.decision.wait_until) || clean(input.context.candidates[0]?.wait_until) ||
    clean(input.context.provider_error?.retry_after_at);
}

function requiredRecoveryMessage(input: IssueSupervisorActionInput): string {
  return clean(input.decision.recovery_message);
}

function decisionID(input: IssueSupervisorActionInput): string {
  return `supervisor-${issueID(input.context)}-${(input.now ?? new Date()).toISOString()}`;
}

function primaryDiagnosis(context: IssueSupervisorRecoveryContext): string {
  return clean(context.candidates[0]?.diagnosis_code) || clean(context.provider_error?.diagnosis_code);
}

function issueID(context: IssueSupervisorRecoveryContext): number {
  return numberValue(context.issue.id) ?? 0;
}

function projectID(context: IssueSupervisorRecoveryContext): string {
  return clean(context.project.id);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(clean).filter(Boolean) : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compact<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== "" && value !== undefined)) as T;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "action failed";
}
