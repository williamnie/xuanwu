import type { RunnerDatabase } from "../db/database.ts";
import { getAgentSession, upsertAgentSession } from "../db/repositories/agentSessions.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { enqueueIssue } from "../db/repositories/issueActions.ts";
import { createIssueComment } from "../db/repositories/issueEvents.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import {
  getPiAction,
  listPiActions,
  updatePiAction,
  type PiAction,
  type PiActionFilter
} from "../db/repositories/pi.ts";
import type { EventBus } from "../events/bus.ts";
import { publishPiActionEvent } from "../pi/actionEngine.ts";
import { isExecutorProviderId, type ExecutorProvider, type ExecutorProviderId } from "../providers/types.ts";
import { HttpError, json } from "./errors.ts";
import type { Router } from "./router.ts";

type PiActionsContext = {
  bus?: EventBus;
  database: RunnerDatabase;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};

export function registerPiActionRoutes(router: Router, context: PiActionsContext): void {
  router.get("/api/pi/actions", (request) => json(listPiActions(context.database, piActionFilter(request))));
  router.post("/api/pi/actions/:id/approve", async (request) => json(await approveAction(context, actionID(request))));
  router.post("/api/pi/actions/:id/reject", (request) => json(rejectAction(context, actionID(request))));
  router.post("/api/pi/actions/:id/execute", async (request) => json(await executeAction(context, actionID(request))));
}

async function approveAction(context: PiActionsContext, id: string): Promise<PiAction> {
  const action = requireAction(context.database, id);
  if (isTerminal(action) || action.status === "executing") return action;
  const approved = action.status === "approved" ? action : writeAction(context, action, "approved", approvedResult(action));
  publishPiActionEvent(context.bus, "pi.action_approved", approved);
  return await executeAction(context, approved.id);
}

function rejectAction(context: PiActionsContext, id: string): PiAction {
  const action = requireAction(context.database, id);
  if (action.status === "rejected" || isExecuted(action)) return action;
  return writeAction(context, action, "rejected", statusResult(action, "rejected"), "pi.action_rejected");
}

async function executeAction(context: PiActionsContext, id: string): Promise<PiAction> {
  const action = requireAction(context.database, id);
  if (isFinished(action)) return action;
  if (action.status === "executing") return action;
  if (action.status !== "approved") {
    throw new HttpError(400, "PI action must be approved before execute");
  }
  const executing = action.status === "executing"
    ? action
    : writeAction(context, action, "executing", statusResult(action, "executing"), "pi.action_executing");
  try {
    return completeAction(context, executing, await dispatchAction(context, executing));
  } catch (error) {
    return writeAction(context, executing, "failed", { error: safeError(error) }, "pi.action_failed");
  }
}

async function dispatchAction(context: PiActionsContext, action: PiAction): Promise<unknown> {
  const db = context.database;
  const payload = parsePayload(action);
  switch (action.action_type) {
    case "issue.create":
      return createIssue(db, payload);
    case "issue.enqueue":
      return enqueueIssue(db, positivePayloadID(payload, "issue_id"));
    case "issue.comment":
      return createIssueComment(db, positivePayloadID(payload, "issue_id"), payload);
    case "issue.update_refinement":
      return updateIssue(db, positivePayloadID(payload, "issue_id"), objectPayload(payload.patch));
    case "session.steer":
      return await steerSession(context, payload);
    default:
      throw new Error(`unsupported PI action type: ${action.action_type}`);
  }
}

async function steerSession(context: PiActionsContext, payload: Record<string, unknown>): Promise<unknown> {
  const providerID = sessionProviderID(payload);
  const sessionID = sessionProviderSessionID(payload);
  const prompt = cleanString(payload.prompt);
  if (prompt === "") throw new Error("prompt is required");
  const provider = context.providers?.[providerID];
  if (!provider?.sendSessionMessage) throw new Error(`provider "${providerID}" 不支持 capability "resume_session"`);
  const result = await provider.sendSessionMessage({
    mode: "steer",
    prompt,
    sessionId: sessionID,
    turnId: latestSessionTurnID(context.database, providerID, sessionID, payload)
  });
  persistSteeredSession(context.database, providerID, sessionID, result.turn_id);
  return result;
}

function completeAction(context: PiActionsContext, action: PiAction, result: unknown): PiAction {
  return writeAction(context, action, "completed", result ?? null, "pi.action_completed");
}

function writeAction(
  context: PiActionsContext,
  action: PiAction,
  status: string,
  result: unknown,
  eventType?: string
): PiAction {
  const next = updatePiAction(context.database, action.id, { status, result_json: JSON.stringify(result) });
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

function parsePayload(action: PiAction): Record<string, unknown> {
  try {
    const value = JSON.parse(action.payload_json || "{}") as unknown;
    return objectPayload(value);
  } catch {
    throw new Error("PI action payload_json is invalid");
  }
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positivePayloadID(payload: Record<string, unknown>, key: string): number {
  const id = payload[key];
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return id;
  throw new Error(`${key} is required`);
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

function sessionProviderID(payload: Record<string, unknown>): ExecutorProviderId {
  const sessionKey = cleanString(payload.session_key);
  const provider = cleanString(payload.provider) || sessionKey.split(":")[0] || "codex";
  if (isExecutorProviderId(provider)) return provider;
  throw new Error("session provider 暂不支持");
}

function sessionProviderSessionID(payload: Record<string, unknown>): string {
  const id = cleanString(payload.provider_session_id) || sessionIDFromKey(cleanString(payload.session_key));
  if (id === "") throw new Error("session id 不能为空");
  return id;
}

function sessionIDFromKey(sessionKey: string): string {
  const separator = sessionKey.indexOf(":");
  return separator < 0 ? sessionKey : sessionKey.slice(separator + 1).trim();
}

function latestSessionTurnID(
  db: RunnerDatabase,
  providerID: ExecutorProviderId,
  sessionID: string,
  payload: Record<string, unknown>
): string {
  const payloadTurnID = cleanString(payload.provider_turn_id) || cleanString(payload.turn_id);
  if (payloadTurnID !== "") return payloadTurnID;
  const session = getAgentSession(db, `${providerID}:${sessionID}`);
  return rawRefTurnID(session?.raw_ref);
}

function rawRefTurnID(rawRef: string | undefined): string {
  if (!rawRef) return "";
  try {
    const parsed = JSON.parse(rawRef) as Record<string, unknown>;
    return cleanString(parsed.provider_turn_id);
  } catch {
    return "";
  }
}

function persistSteeredSession(
  db: RunnerDatabase,
  provider: ExecutorProviderId,
  sessionID: string,
  turnID: string
): void {
  if (turnID === "") return;
  upsertAgentSession(db, {
    provider,
    provider_session_id: sessionID,
    raw_ref: { provider_turn_id: turnID },
    status: "running"
  });
}
