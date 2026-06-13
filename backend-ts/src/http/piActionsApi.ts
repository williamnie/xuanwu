import type { RunnerDatabase } from "../db/database.ts";
import { dispatchPiAction } from "./piActionDispatch.ts";
import {
  getPiAction,
  listPiActionEvents,
  listPiActions,
  updatePiAction,
  type PiAction,
  type PiActionFilter,
  type PiActionInput
} from "../db/repositories/pi.ts";
import type { EventBus } from "../events/bus.ts";
import { publishPiActionEvent, recordPiActionAuditEvent } from "../pi/actionEngine.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import type { ProjectLoopStarter } from "./piActionDispatch.ts";
import type { Router } from "./router.ts";

type PiActionsContext = {
  bus?: EventBus;
  database: RunnerDatabase;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  startProjectLoop?: ProjectLoopStarter;
};

export function registerPiActionRoutes(router: Router, context: PiActionsContext): void {
  router.get("/api/pi/actions", (request) => json(listPiActions(context.database, piActionFilter(request))));
  router.get("/api/pi/actions/:id/events", (request) => json(listPiActionEvents(context.database, { actionId: actionID(request) })));
  router.get("/api/pi/audit-events", (request) => json(listPiActionEvents(context.database, piActionEventFilter(request))));
  router.post("/api/pi/actions/:id/approve", async (request) => json(await approveAction(context, actionID(request))));
  router.post("/api/pi/actions/:id/reject", (request) => json(rejectAction(context, actionID(request))));
  router.post("/api/pi/actions/:id/request-changes", async (request) => json(await requestChangesAction(context, actionID(request), request)));
  router.post("/api/pi/actions/:id/snooze", async (request) => json(await snoozeAction(context, actionID(request), request)));
  router.post("/api/pi/actions/:id/execute", async (request) => json(await executeAction(context, actionID(request))));
}

async function approveAction(context: PiActionsContext, id: string): Promise<PiAction> {
  const action = requireAction(context.database, id);
  if (isTerminal(action) || action.status === "executing") return action;
  assertApprovableGate(action);
  const approved = action.status === "approved" ? action : approvePendingAction(context, action);
  return await executeAction(context, approved.id);
}

function rejectAction(context: PiActionsContext, id: string): PiAction {
  const action = requireAction(context.database, id);
  if (action.status === "rejected" || isExecuted(action)) return action;
  const rejected = writeAction(context, action, "rejected", statusResult(action, "rejected"), "pi.action_rejected");
  recordPiActionAuditEvent(context.database, rejected, "approval_decision", {
    actor: "user", decision: "reject", reason: "user rejected action"
  });
  return rejected;
}

async function requestChangesAction(context: PiActionsContext, id: string, request: Request): Promise<PiAction> {
  const action = requireAction(context.database, id);
  if (isExecuted(action)) return action;
  const body = await parseObjectBody(request);
  const comment = cleanString(body.comment || body.reason || body.requested_changes);
  const next = updatePiAction(context.database, action.id, {
    decided_by: cleanString(body.actor) || "user",
    requested_changes: comment,
    result_json: JSON.stringify({ ...statusResult(action, "changes_requested"), requested_changes: comment }),
    status: "changes_requested"
  });
  recordPiActionAuditEvent(context.database, next, "approval_decision", {
    actor: next.decided_by, decision: "request_changes", reason: comment
  });
  publishPiActionEvent(context.bus, "pi.action_changes_requested", next);
  return next;
}

async function snoozeAction(context: PiActionsContext, id: string, request: Request): Promise<PiAction> {
  const action = requireAction(context.database, id);
  if (isExecuted(action)) return action;
  const body = await parseObjectBody(request);
  const until = cleanString(body.until || body.snoozed_until);
  assertSnoozedUntil(until);
  const reason = cleanString(body.reason) || "user snoozed action";
  const next = updatePiAction(context.database, action.id, {
    decided_by: cleanString(body.actor) || "user",
    gate_decision: "snooze",
    result_json: JSON.stringify({ ...statusResult(action, "snoozed"), snoozed_until: until }),
    snoozed_until: until,
    status: "snoozed"
  });
  recordPiActionAuditEvent(context.database, next, "approval_decision", {
    actor: next.decided_by, decision: "snooze", reason
  });
  publishPiActionEvent(context.bus, "pi.action_snoozed", next);
  return next;
}

async function executeAction(context: PiActionsContext, id: string): Promise<PiAction> {
  const action = requireAction(context.database, id);
  if (isFinished(action)) return action;
  if (action.status === "executing") return action;
  if (action.status !== "approved") {
    throw new HttpError(400, "PI action must be approved before execute");
  }
  assertExecutableGate(action);
  const executing = writeExecutingAction(context, action);
  try {
    return completeAction(context, executing, await dispatchPiAction(context, executing));
  } catch (error) {
    const failed = writeAction(context, executing, "failed", { error: safeError(error) }, "pi.action_failed");
    recordPiActionAuditEvent(context.database, failed, "execution_error", { actor: "executor", error: safeError(error) });
    return failed;
  }
}

function completeAction(context: PiActionsContext, action: PiAction, result: unknown): PiAction {
  const completed = writeAction(context, action, "completed", result ?? null, "pi.action_completed");
  recordPiActionAuditEvent(context.database, completed, "execution_result", { actor: "executor", result });
  return completed;
}

function approvePendingAction(context: PiActionsContext, action: PiAction): PiAction {
  const approved = writeAction(context, action, "approved", approvedResult(action), "pi.action_approved", { approved_by: "user" });
  recordPiActionAuditEvent(context.database, approved, "approval_decision", {
    actor: approved.approved_by || "user", decision: "approve", reason: "user approved action"
  });
  return approved;
}

function writeExecutingAction(context: PiActionsContext, action: PiAction): PiAction {
  const executing = writeAction(context, action, "executing", statusResult(action, "executing"), "pi.action_executing");
  recordPiActionAuditEvent(context.database, executing, "execution_started", { actor: "gate", decision: "execute" });
  return executing;
}

function writeAction(
  context: PiActionsContext,
  action: PiAction,
  status: string,
  result: unknown,
  eventType?: string,
  patch: PiActionInput = {}
): PiAction {
  const next = updatePiAction(context.database, action.id, { ...patch, status, result_json: JSON.stringify(result) });
  if (eventType) publishPiActionEvent(context.bus, eventType, next);
  return next;
}

function approvedResult(action: PiAction): Record<string, unknown> {
  return { ...statusResult(action, "approved"), approved_at: new Date().toISOString() };
}

function statusResult(action: PiAction, status: string): Record<string, unknown> {
  return { action_id: action.id, action_type: action.action_type, status };
}

function requireAction(db: RunnerDatabase, id: string): PiAction {
  const action = getPiAction(db, id);
  if (!action) throw new HttpError(404, "资源不存在");
  return action;
}

function assertApprovableGate(action: PiAction): void {
  if (action.status === "denied" || action.gate_decision === "deny") {
    throw new HttpError(409, "PI action was denied by approval gate");
  }
  if (action.status !== "pending" && action.status !== "approved") {
    throw new HttpError(409, `PI action cannot be approved from status ${action.status}`);
  }
  if (action.gate_decision !== "ask" && action.gate_decision !== "execute") {
    throw new HttpError(409, "PI action must pass approval gate before approve");
  }
}

function assertExecutableGate(action: PiAction): void {
  if (action.gate_decision === "deny") throw new HttpError(409, "PI action was denied by approval gate");
  if (action.gate_decision === "snooze") throw new HttpError(409, "PI action is snoozed by approval gate");
  if (action.gate_decision !== "ask" && action.gate_decision !== "execute") {
    throw new HttpError(409, "PI action must pass approval gate before execute");
  }
}

function assertSnoozedUntil(until: string): void {
  if (until === "") throw new HttpError(400, "snoozed_until 不能为空");
  if (!Number.isFinite(Date.parse(until))) throw new HttpError(400, "snoozed_until 必须是合法时间");
}

function isFinished(action: PiAction): boolean {
  return action.status === "completed" || action.status === "failed";
}

function isTerminal(action: PiAction): boolean {
  return isFinished(action) || action.status === "rejected";
}

function isExecuted(action: PiAction): boolean {
  return action.status === "completed" || action.status === "failed" || action.status === "executing";
}

function actionID(request: Request): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const value = parts[parts.indexOf("actions") + 1]?.trim() ?? "";
  if (value === "") throw new HttpError(400, "PI action id 不能为空");
  return decodeURIComponent(value);
}

function piActionEventFilter(request: Request) {
  const params = new URL(request.url).searchParams;
  return {
    actionId: cleanParam(params.get("action_id")),
    conversationId: cleanParam(params.get("conversation_id")),
    delegationId: cleanParam(params.get("delegation_id")),
    issueId: positiveID(params.get("issue_id")),
    projectId: cleanParam(params.get("project_id"))
  };
}

async function parseObjectBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await parseJsonBody(request);
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch (error) {
    if (error instanceof HttpError) return {};
    throw error;
  }
}

function piActionFilter(request: Request): PiActionFilter {
  const params = new URL(request.url).searchParams;
  return {
    conversationId: cleanParam(params.get("conversation_id")),
    issueId: positiveID(params.get("issue_id")),
    projectId: cleanParam(params.get("project_id")),
    status: cleanParam(params.get("status"))
  };
}

function positiveID(value: string | null): number | undefined {
  const text = cleanParam(value);
  if (text === "") return undefined;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function cleanParam(value: string | null): string {
  return value?.trim() ?? "";
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "PI action failed";
}
