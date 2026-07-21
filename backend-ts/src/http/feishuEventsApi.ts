import type { RunnerDatabase } from "../db/database.ts";
import type { FeishuConnectorConfig } from "../integrations/feishu.ts";
import {
  feishuConnectorStatus,
  parseFeishuCallbackPayload,
  verifyFeishuCallbackSignature,
  FeishuCallbackPayloadError
} from "../integrations/feishu.ts";
import type { EventBus } from "../events/bus.ts";
import { cleanString, recordValue } from "../integrations/feishuShared.ts";
import { ingestFeishuMessageEvent, publishFeishuAudit, rawPayloadRef } from "../integrations/feishuIngest.ts";
import { normalizeFeishuMessageEvent } from "../integrations/feishu.ts";
import { normalizeFeishuProjectSelectionAction } from "../integrations/feishuProjectSelection.ts";
import { normalizeFeishuApprovalAction } from "../integrations/feishuApprovalCards.ts";
import { resolvePiApprovalRequestFromFeishu } from "../integrations/feishuApprovalRequests.ts";
import { normalizeFeishuPiActionCardAction } from "../integrations/feishuPiActionCards.ts";
import { resolvePiActionFromFeishu } from "../integrations/feishuPiActionResolve.ts";
import { projectSelectionCallbackAcceptedBody } from "../integrations/feishuCardCallbackResponse.ts";
import type { createFeishuAgentBridge } from "../integrations/feishuAgentBridge.ts";
import {
  routeFeishuMessageToGenericIntake,
  type FeishuGenericIntakeOptions
} from "../integrations/feishuIntakeBridge.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import type { EventRouterSourcePolicy } from "../pi/eventRouter.ts";
import type { LlmIntakeModel } from "../pi/llmIntake.ts";
import { json, jsonError } from "./errors.ts";
import type { Router } from "./router.ts";

export type FeishuEventRoutesContext = {
  agentBridge?: ReturnType<typeof createFeishuAgentBridge>;
  bus?: EventBus;
  config: FeishuConnectorConfig;
  database?: RunnerDatabase;
  feishuIntakeModel?: LlmIntakeModel;
  feishuIntakePolicy?: EventRouterSourcePolicy;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};

type AuditPayload = {
  connector: "feishu";
  encrypted?: boolean;
  outcome: "challenge" | "received" | "rejected";
  raw_payload_ref: string;
  reason: string;
  transport: "callback";
};

export function registerFeishuEventRoutes(router: Router, context: FeishuEventRoutesContext): void {
  router.post("/api/integrations/feishu/events", (request) => handleFeishuEvent(request, context));
}

async function handleFeishuEvent(request: Request, context: FeishuEventRoutesContext): Promise<Response> {
  if (connectorDisabled(context.config)) return jsonError(503, "feishu connector is not configured");
  const rawBody = await request.text();
  const rawRef = rawPayloadRef(rawBody);
  publishAudit(context, { connector: "feishu", outcome: "received", raw_payload_ref: rawRef, reason: "callback_received", transport: "callback" });
  const parsed = parseCallback(rawBody, context, rawRef);
  if (parsed instanceof Response) return parsed;
  if (isChallenge(parsed.body)) return challengeResponse(parsed.body, context, rawRef, parsed.encrypted);
  const signature = verifyCallbackSignature(request, context.config, rawBody);
  if (signature) return reject(context, signature.reason, rawRef, 401, parsed.encrypted);
  if (!validToken(parsed.body, context.config.verificationToken)) {
    return reject(context, "invalid_verification_token", rawRef, 401, parsed.encrypted);
  }
  const approvalAction = normalizeFeishuApprovalAction(parsed.body);
  if (approvalAction) {
    if (!context.database) return json({ ok: false, reason: "database_unavailable" }, { status: 503 });
    if (!approvalActionAllowed(context.config, approvalAction)) {
      return reject(context, "approval_callback_forbidden", rawRef, 403, parsed.encrypted, "feishu approval callback is not allowed");
    }
    try {
      const result = await resolvePiApprovalRequestFromFeishu(context.database, {
        ...approvalAction,
        providers: context.providers
      });
      return json(result, { status: 202 });
    } catch (error) {
      return reject(context, "approval_callback_failed", rawRef, 409, parsed.encrypted, safeError(error));
    }
  }
  const piAction = normalizeFeishuPiActionCardAction(parsed.body);
  if (piAction) {
    if (!context.database) return json({ ok: false, reason: "database_unavailable" }, { status: 503 });
    if (!approvalActionAllowed(context.config, piAction)) {
      return reject(context, "pi_action_callback_forbidden", rawRef, 403, parsed.encrypted, "feishu approval callback is not allowed");
    }
    try {
      return json(await resolvePiActionFromFeishu({ ...context, database: context.database }, piAction), { status: 202 });
    } catch (error) {
      return reject(context, "pi_action_callback_failed", rawRef, 409, parsed.encrypted, safeError(error));
    }
  }
  const projectAction = normalizeFeishuProjectSelectionAction(parsed.body);
  if (projectAction) {
    void context.agentBridge?.handleProjectSelectionAction(projectAction).catch((error) => {
      console.warn(JSON.stringify({
        action: "feishu_project_selection_callback",
        error: safeError(error),
        ok: false,
        selection_id: projectAction.selection_id
      }));
    });
    return projectSelectionCallbackAccepted();
  }
  return await acceptMessageEvent(parsed.body, context, rawRef, parsed.encrypted);
}

function projectSelectionCallbackAccepted(): Response {
  return json(projectSelectionCallbackAcceptedBody());
}

async function acceptMessageEvent(
  body: Record<string, unknown>,
  context: FeishuEventRoutesContext,
  rawRef: string,
  encrypted: boolean
): Promise<Response> {
  try {
    const event = normalizeFeishuMessageEvent(body, { rawEventRef: rawRef });
    const ingest = ingestFeishuMessageEvent(body, context, {
      encrypted,
      rawPayloadRef: rawRef,
      transport: "callback"
    });
    await routeGenericIntake(context, ingest);
    void context.agentBridge?.handle({ event, ingest });
    return json(ingest, { status: 202 });
  } catch {
    return reject(context, "unsupported_or_invalid_event", rawRef, 400, encrypted);
  }
}

async function routeGenericIntake(
  context: FeishuEventRoutesContext,
  ingest: FeishuGenericIntakeOptions["ingest"]
): Promise<void> {
  if (!context.database || !context.feishuIntakeModel) return;
  try {
    await routeFeishuMessageToGenericIntake({
      database: context.database,
      ingest,
      model: context.feishuIntakeModel,
      policy: context.feishuIntakePolicy
    });
  } catch (error) {
    console.warn(JSON.stringify({
      action: "feishu_generic_intake",
      error: safeError(error),
      ok: false
    }));
  }
}

function challengeResponse(body: Record<string, unknown>, context: FeishuEventRoutesContext, rawRef: string, encrypted: boolean): Response {
  if (!validToken(body, context.config.verificationToken)) return reject(context, "invalid_verification_token", rawRef, 401, encrypted);
  publishAudit(context, { connector: "feishu", encrypted, outcome: "challenge", raw_payload_ref: rawRef, reason: "challenge_verified", transport: "callback" });
  return json({ challenge: cleanString(body.challenge) });
}

function parseCallback(
  rawBody: string,
  context: FeishuEventRoutesContext,
  rawRef: string
): { body: Record<string, unknown>; encrypted: boolean } | Response {
  try {
    return parseFeishuCallbackPayload(rawBody, context.config.encryptKey);
  } catch (error) {
    if (error instanceof FeishuCallbackPayloadError) return reject(context, error.reason, rawRef, error.status, false, error.message);
    return reject(context, "invalid_json", rawRef, 400, false, "invalid feishu callback json");
  }
}

function verifyCallbackSignature(request: Request, config: FeishuConnectorConfig, rawBody: string): { reason: string } | null {
  if (cleanString(config.encryptKey) === "") return null;
  const result = verifyFeishuCallbackSignature({ encryptKey: config.encryptKey, headers: request.headers, rawBody });
  return result.ok ? null : { reason: result.reason };
}

function reject(
  context: FeishuEventRoutesContext,
  reason: string,
  rawRef: string,
  status: number,
  encrypted: boolean,
  message = "feishu callback rejected"
): Response {
  publishAudit(context, { connector: "feishu", encrypted, outcome: "rejected", raw_payload_ref: rawRef, reason, transport: "callback" });
  return jsonError(status, message);
}

function connectorDisabled(config: FeishuConnectorConfig): boolean {
  return feishuConnectorStatus(config).enabled !== true;
}

function isChallenge(body: Record<string, unknown>): boolean {
  return cleanString(body.type) === "url_verification" && cleanString(body.challenge) !== "";
}

function validToken(body: Record<string, unknown>, expected: string): boolean {
  const header = recordValue(body.header);
  return cleanString(body.token || header.token) === cleanString(expected);
}

function approvalActionAllowed(
  config: FeishuConnectorConfig,
  action: { chatID?: string; userID?: string; userOpenID?: string }
): boolean {
  const chatAllowed = targetAllowed(config.allowedChatIds, cleanString(action.chatID));
  const userAllowed = targetAllowed(config.allowedUserIds, cleanString(action.userID)) ||
    targetAllowed(config.allowedUserIds, cleanString(action.userOpenID));
  if (!chatAllowed) return false;
  if (!userAllowed) return false;
  return true;
}

function targetAllowed(allowlist: string[], value: string): boolean {
  return allowlist.length === 0 || (value !== "" && allowlist.includes(value));
}

function publishAudit(context: FeishuEventRoutesContext, payload: AuditPayload): void {
  publishFeishuAudit(context, payload);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "approval callback failed";
}
