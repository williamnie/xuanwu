import type { RunnerDatabase } from "../db/database.ts";
import { createPiAction, type PiAction } from "../db/repositories/pi.ts";
import type { AppEvent, EventBus } from "../events/bus.ts";

export type PiRiskGate = "safe" | "confirm" | "high";
export type PiRiskClassification = {
  gate: PiRiskGate;
  requiresConfirmation: boolean;
  riskLevel: "low" | "medium" | "high";
};

export type PiActionRequest = {
  actionType: string;
  conversationID?: string;
  issueID?: number;
  payload: Record<string, unknown>;
  projectID?: string;
  rationale?: string;
};

export type PiActionContext = {
  bus?: EventBus;
  conversationID?: string;
};

type SafeActionInput = PiActionRequest & { execute: () => unknown };

const SAFE_ACTIONS = new Set([
  "issue.comment",
  "issue.list",
  "issue.read",
  "project.list",
  "project.status",
  "session.list",
  "session.read_summary"
]);

const CONFIRM_ACTIONS = new Set([
  "issue.create",
  "issue.enqueue",
  "issue.update_refinement"
]);

const HIGH_RISK_ACTIONS = new Set(["session.steer"]);

export function classifyPiActionRisk(actionType: string): PiRiskClassification {
  if (SAFE_ACTIONS.has(actionType)) return risk("safe", "low");
  if (CONFIRM_ACTIONS.has(actionType)) return risk("confirm", "medium");
  if (HIGH_RISK_ACTIONS.has(actionType)) return risk("high", "high");
  return risk("high", "high");
}

export function executeSafePiAction(db: RunnerDatabase, context: PiActionContext, input: SafeActionInput) {
  const classification = classifyPiActionRisk(input.actionType);
  if (classification.requiresConfirmation) throw new Error("action requires confirmation");
  try {
    const result = input.execute();
    completedAction(db, context, input, result);
    return result;
  } catch (error) {
    failedAction(db, context, input, safeError(error));
    throw error;
  }
}

export function createPendingPiAction(
  db: RunnerDatabase,
  context: PiActionContext,
  input: PiActionRequest
) {
  const classification = classifyPiActionRisk(input.actionType);
  const id = crypto.randomUUID();
  const result = actionResult(id, input, classification, "pending");
  const action = createPiActionRecord(db, context, input, result, JSON.stringify(result));
  publishPiActionEvent(context.bus, "pi.action_pending", action);
  return result;
}

function completedAction(db: RunnerDatabase, context: PiActionContext, input: PiActionRequest, result: unknown) {
  const classification = classifyPiActionRisk(input.actionType);
  const id = crypto.randomUUID();
  const output = {
    ...actionResult(id, input, classification, "completed"),
    result,
    result_json: JSON.stringify(result ?? null)
  };
  const action = createPiActionRecord(db, context, input, output, JSON.stringify(result ?? null));
  publishPiActionEvent(context.bus, "pi.action_completed", action);
  return output;
}

function failedAction(db: RunnerDatabase, context: PiActionContext, input: PiActionRequest, error: string): void {
  const classification = classifyPiActionRisk(input.actionType);
  const id = crypto.randomUUID();
  const output = { ...actionResult(id, input, classification, "failed"), error };
  const action = createPiActionRecord(db, context, input, output, JSON.stringify({ error }));
  publishPiActionEvent(context.bus, "pi.action_failed", action);
}

function createPiActionRecord(
  db: RunnerDatabase,
  context: PiActionContext,
  input: PiActionRequest,
  output: ReturnType<typeof actionResult>,
  resultJSON: string
): PiAction {
  return createPiAction(db, {
    id: output.action_id,
    action_type: input.actionType,
    conversation_id: cleanString(input.conversationID) || cleanString(context.conversationID),
    issue_id: input.issueID ?? 0,
    payload_json: JSON.stringify(input.payload),
    project_id: cleanString(input.projectID),
    rationale: cleanString(input.rationale),
    requires_confirmation: output.requires_confirmation ? 1 : 0,
    result_json: resultJSON,
    risk_level: output.risk_level,
    status: output.status
  });
}

function actionResult(
  id: string,
  input: PiActionRequest,
  classification: PiRiskClassification,
  status: string
) {
  return {
    action_id: id,
    action_type: input.actionType,
    issue_id: input.issueID ?? 0,
    requires_confirmation: classification.requiresConfirmation,
    risk_level: classification.riskLevel,
    status
  };
}

function risk(gate: PiRiskGate, riskLevel: PiRiskClassification["riskLevel"]): PiRiskClassification {
  return { gate, requiresConfirmation: gate !== "safe", riskLevel };
}

function publishPiActionEvent(bus: EventBus | undefined, type: string, action: PiAction): void {
  bus?.publish(piActionEvent(type, action));
}

function piActionEvent(type: string, action: PiAction): AppEvent {
  return {
    type,
    conversationId: action.conversation_id,
    issueId: action.issue_id || undefined,
    projectId: action.project_id,
    payload: JSON.stringify({
      action_id: action.id,
      action_type: action.action_type,
      requires_confirmation: action.requires_confirmation === 1,
      risk_level: action.risk_level,
      status: action.status
    }),
    created_at: action.updated_at
  };
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "action failed";
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
