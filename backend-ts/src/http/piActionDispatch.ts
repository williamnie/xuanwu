import type { RunnerDatabase } from "../db/database.ts";
import { getAgentSession, upsertAgentSession } from "../db/repositories/agentSessions.ts";
import { enqueueIssue } from "../db/repositories/issueActions.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { createIssueComment } from "../db/repositories/issueEvents.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { applyIssueStateRepair } from "../pi/issueStateManager.ts";
import type { PiAction } from "../db/repositories/pi.ts";
import { isExecutorProviderId, type ExecutorProvider, type ExecutorProviderId } from "../providers/types.ts";

export type PiActionDispatchContext = {
  database: RunnerDatabase;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};

export async function dispatchPiAction(
  context: PiActionDispatchContext,
  action: PiAction
): Promise<unknown> {
  const payload = parsePayload(action);
  switch (action.action_type) {
    case "issue.create":
      return createIssue(context.database, payload);
    case "issue.enqueue":
      return enqueueIssue(context.database, positivePayloadID(payload, "issue_id"));
    case "issue.comment":
      return createIssueComment(context.database, positivePayloadID(payload, "issue_id"), payload);
    case "issue.update_refinement":
      return updateIssue(context.database, positivePayloadID(payload, "issue_id"), objectPayload(payload.patch));
    case "issue.state_repair":
      return applyIssueStateRepair(context.database, payload);
    case "agent.executor_assign":
      return updateIssue(context.database, positivePayloadID(payload, "issue_id"), objectPayload(payload.patch));
    case "agent.workflow_request":
      return createIssue(context.database, payload);
    case "needs_user.escalate":
      return createIssueComment(context.database, positivePayloadID(payload, "issue_id"), {
        author: "agent",
        body: cleanString(payload.body)
      });
    case "session.steer":
      return await steerSession(context, payload);
    default:
      throw new Error(`unsupported PI action type: ${action.action_type}`);
  }
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

async function steerSession(
  context: PiActionDispatchContext,
  payload: Record<string, unknown>
): Promise<unknown> {
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

function sessionIDFromKey(sessionKey: string): string {
  const separator = sessionKey.indexOf(":");
  return separator < 0 ? sessionKey : sessionKey.slice(separator + 1).trim();
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

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
