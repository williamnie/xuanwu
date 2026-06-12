import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../db/database.ts";
import { upsertExternalEvent } from "../db/repositories/externalEvents.ts";
import { listProjects } from "../db/repositories/projects.ts";
import type { FeishuConnectorConfig, FeishuNormalizedMessageEvent } from "../integrations/feishu.ts";
import {
  feishuConnectorStatus,
  feishuExternalEventInput,
  normalizeFeishuMessageEvent,
  parseFeishuCallbackPayload,
  projectIDForFeishuMessage,
  verifyFeishuCallbackSignature,
  FeishuCallbackPayloadError
} from "../integrations/feishu.ts";
import type { EventBus } from "../events/bus.ts";
import { cleanString, recordValue } from "../integrations/feishuShared.ts";
import { decidePiAttention, type PiAttentionDecision } from "../pi/attentionRouter.ts";
import { json, jsonError } from "./errors.ts";
import type { Router } from "./router.ts";

export type FeishuEventRoutesContext = {
  bus?: EventBus;
  config: FeishuConnectorConfig;
  database?: RunnerDatabase;
};

type AuditPayload = {
  connector: "feishu";
  dedupe_key?: string;
  encrypted?: boolean;
  normalized_summary?: Record<string, unknown>;
  outcome: "accepted" | "challenge" | "received" | "rejected";
  raw_payload_ref: string;
  reason: string;
};

export function registerFeishuEventRoutes(router: Router, context: FeishuEventRoutesContext): void {
  router.post("/api/integrations/feishu/events", (request) => handleFeishuEvent(request, context));
}

async function handleFeishuEvent(request: Request, context: FeishuEventRoutesContext): Promise<Response> {
  if (connectorDisabled(context.config)) return jsonError(503, "feishu connector is not configured");
  const rawBody = await request.text();
  const rawRef = rawPayloadRef(rawBody);
  publishAudit(context, { connector: "feishu", outcome: "received", raw_payload_ref: rawRef, reason: "callback_received" });
  const parsed = parseCallback(rawBody, context, rawRef);
  if (parsed instanceof Response) return parsed;
  if (isChallenge(parsed.body)) return challengeResponse(parsed.body, context, rawRef, parsed.encrypted);
  const signature = verifyCallbackSignature(request, context.config, rawBody);
  if (signature) return reject(context, signature.reason, rawRef, 401, parsed.encrypted);
  if (!validToken(parsed.body, context.config.verificationToken)) {
    return reject(context, "invalid_verification_token", rawRef, 401, parsed.encrypted);
  }
  return acceptMessageEvent(parsed.body, context, rawRef, parsed.encrypted);
}

function acceptMessageEvent(
  body: Record<string, unknown>,
  context: FeishuEventRoutesContext,
  rawRef: string,
  encrypted: boolean
): Response {
  try {
    const event = normalizeFeishuMessageEvent(body, { rawEventRef: rawRef });
    const attention = attentionDecision(context, event);
    const summary = normalizedSummary(event, attention.project_id, attention);
    const inboxEvent = saveInboxEvent(context, event, attention);
    publishAudit(context, {
      connector: "feishu",
      dedupe_key: event.dedupe_key,
      encrypted,
      normalized_summary: summary,
      outcome: "accepted",
      raw_payload_ref: rawRef,
      reason: "message_normalized"
    });
    return json({
      dedupe_key: event.dedupe_key,
      event_id: inboxEvent?.id ?? 0,
      ok: true,
      normalized_summary: summary
    }, { status: 202 });
  } catch {
    return reject(context, "unsupported_or_invalid_event", rawRef, 400, encrypted);
  }
}

function challengeResponse(body: Record<string, unknown>, context: FeishuEventRoutesContext, rawRef: string, encrypted: boolean): Response {
  if (!validToken(body, context.config.verificationToken)) return reject(context, "invalid_verification_token", rawRef, 401, encrypted);
  publishAudit(context, { connector: "feishu", encrypted, outcome: "challenge", raw_payload_ref: rawRef, reason: "challenge_verified" });
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
  publishAudit(context, { connector: "feishu", encrypted, outcome: "rejected", raw_payload_ref: rawRef, reason });
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

function normalizedSummary(
  event: FeishuNormalizedMessageEvent,
  projectId: string,
  attention: PiAttentionDecision
): Record<string, unknown> {
  return {
    attention_decision: attention,
    attachment_count: event.attachments.length,
    chat_id: event.chat_id,
    message_id: event.message_id,
    project_id: projectId,
    sender_type: event.sender.type,
    text_length: event.text.length
  };
}

function saveInboxEvent(
  context: FeishuEventRoutesContext,
  event: FeishuNormalizedMessageEvent,
  attention: PiAttentionDecision
) {
  if (!context.database) return null;
  const input = feishuExternalEventInput(event, { projectId: attention.project_id });
  return upsertExternalEvent(context.database, {
    ...input,
    status: inboxStatus(input.status, attention),
    summary: { ...input.summary, attention_decision: attention }
  });
}

function attentionDecision(context: FeishuEventRoutesContext, event: FeishuNormalizedMessageEvent): PiAttentionDecision {
  const fallbackProject = projectIDForFeishuMessage(context.config, event);
  const decision = decidePiAttention({
    message: {
      attachments: event.attachments,
      chat_id: event.chat_id,
      mentions: event.mentions,
      message_id: event.message_id,
      sender_id: event.sender.id,
      sender_open_id: event.sender.open_id,
      text: event.text
    },
    policy: context.config,
    projects: context.database ? listProjects(context.database).map((item) => ({ id: item.id, name: item.name })) : []
  });
  return decision.project_id === "" && fallbackProject !== "" ? { ...decision, project_id: fallbackProject } : decision;
}

function inboxStatus(current: unknown, attention: PiAttentionDecision): string {
  if (attention.decision === "ignore") return "ignored";
  if (attention.decision === "ask_clarification") return "needs_project";
  if (attention.decision === "blocked_by_policy") return "blocked_by_policy";
  if (attention.decision === "inbox_only") return "inbox_only";
  return cleanString(current) || "mapped";
}

function publishAudit(context: FeishuEventRoutesContext, payload: AuditPayload): void {
  context.bus?.publish({ payload: JSON.stringify(payload), type: "integration.feishu.audit" });
}

function rawPayloadRef(rawBody: string): string {
  return `sha256:${createHash("sha256").update(rawBody).digest("hex")}`;
}
