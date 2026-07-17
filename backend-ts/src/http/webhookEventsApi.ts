import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { RunnerDatabase } from "../db/database.ts";
import { upsertExternalEvent, type ExternalEventRecord } from "../db/repositories/externalEvents.ts";
import { createExternalLink, listExternalLinksByExternal } from "../db/repositories/externalLinks.ts";
import { getProject } from "../db/repositories/projects.ts";
import { createIssueBackedWork, getIssueBackedWork } from "../domain/work/issueAdapter.ts";
import type { WorkLedgerEntry, WorkTransitionAudit } from "../domain/work/contracts.ts";
import {
  CHANNEL_CONNECTOR_CONTRACT_VERSION,
  assertConnectorConformance,
  type ChannelConnector,
  type ConnectorManifest,
  type InboundEnvelope,
  validateInboundEnvelope
} from "../integrations/channelConnectorContracts.ts";
import { json } from "./errors.ts";
import type { Router } from "./router.ts";

const WEBHOOK_MAX_AGE_MS = 5 * 60 * 1000;
const WEBHOOK_SOURCE = "webhook";
const WORK_CREATE_EVENT = "work.create";
const WORK_CREATE_LINK_TYPE = "webhook_work_create";
const SIGNATURE_PREFIX = "v1=";

export const WEBHOOK_CHANNEL_MANIFEST: ConnectorManifest = {
  auth_refs: [{ kind: "secret_ref", ref: "env://XUANWU_WEBHOOK_SIGNING_SECRET" }],
  capabilities: [{ id: WORK_CREATE_EVENT, kind: "inbound", requires_authorization: true }],
  contract_version: CHANNEL_CONNECTOR_CONTRACT_VERSION,
  display_name: "Signed Work Webhook",
  id: WEBHOOK_SOURCE,
  kind: "channel"
};

export type WebhookEventRoutesContext = {
  database: RunnerDatabase;
  now?: () => Date;
  signingSecret?: string;
};

type NormalizedWebhookWorkCreate = {
  envelope: InboundEnvelope;
  goal: string;
  idempotency_key: string;
  occurred_at: string;
  project_id: string;
  raw_payload_sha256: string;
  raw_payload: Record<string, unknown>;
  status: "todo" | "triage";
  title: string;
  work_audit: WorkTransitionAudit;
};

type SignatureVerification =
  | { idempotency_key: string; ok: true; timestamp: string }
  | { code: string; message: string; ok: false };

/**
 * Public callback endpoint for automation/CI. It is deliberately unauthenticated
 * at the runner bearer layer; the HMAC, timestamp and replay key are its auth.
 */
export function registerWebhookEventRoutes(router: Router, context: WebhookEventRoutesContext): void {
  assertConnectorConformance(webhookConnector());
  router.post("/api/integrations/webhook/events", (request) => handleWebhookEvent(request, context));
}

async function handleWebhookEvent(request: Request, context: WebhookEventRoutesContext): Promise<Response> {
  const secret = clean(context.signingSecret ?? Bun.env.XUANWU_WEBHOOK_SIGNING_SECRET);
  if (secret === "") return webhookError(503, "webhook_unavailable", "webhook signing is not configured");
  const rawBody = await request.text();
  const verification = verifySignature(request.headers, rawBody, secret, context.now?.() ?? new Date());
  if (!verification.ok) return webhookError(401, verification.code, verification.message);

  const parsed = parseBody(rawBody);
  if (parsed instanceof Response) return parsed;
  const normalized = normalizeWebhookWorkCreate(parsed, verification.idempotency_key, verification.timestamp, rawBody);
  if (normalized instanceof Response) return normalized;
  const externalEvent = persistInboundEvent(context.database, normalized);
  if (externalEvent instanceof Response) return externalEvent;

  const existing = existingWork(context.database, externalEvent);
  if (existing) return acceptedResponse(existing, externalEvent, true);
  try {
    const result = createIssueBackedWork(context.database, {
      audit: normalized.work_audit,
      goal: normalized.goal,
      project_id: normalized.project_id,
      status: normalized.status,
      title: normalized.title,
      type: "engineering_task"
    });
    if (!result.applied) return webhookError(409, "work_mutation_rejected", "Work mutation rejected");
    createExternalLink(context.database, {
      external_event_id: externalEvent.id,
      external_id: externalEvent.external_id,
      external_type: WORK_CREATE_LINK_TYPE,
      issue_id: issueIDFromWork(result.work),
      project_id: normalized.project_id,
      relationship: "work_create",
      source: WEBHOOK_SOURCE
    });
    return acceptedResponse(result.work, externalEvent, false);
  } catch (error) {
    if (error instanceof Error && error.message === "project not found") {
      return webhookError(404, "project_not_found", "Project not found");
    }
    return webhookError(400, "invalid_event", "webhook event is invalid");
  }
}

function webhookConnector(): ChannelConnector {
  return {
    manifest: WEBHOOK_CHANNEL_MANIFEST,
    health: () => ({ checked_at: new Date().toISOString(), last_error: "", reconnect_attempts: 0, state: "healthy" }),
    ingest: () => undefined
  };
}

function verifySignature(
  headers: Headers,
  rawBody: string,
  secret: string,
  now: Date
): SignatureVerification {
  const idempotencyKey = clean(headers.get("idempotency-key"));
  if (!validKey(idempotencyKey)) return { code: "invalid_idempotency_key", message: "Idempotency-Key is required", ok: false };
  const timestamp = clean(headers.get("x-xuanwu-timestamp"));
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(now.getTime() - timestampMs) > WEBHOOK_MAX_AGE_MS) {
    return { code: "invalid_signature_timestamp", message: "webhook timestamp is invalid or expired", ok: false };
  }
  const expected = `${SIGNATURE_PREFIX}${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
  const received = clean(headers.get("x-xuanwu-signature"));
  if (!safeEqual(received, expected)) return { code: "invalid_signature", message: "webhook signature is invalid", ok: false };
  return { idempotency_key: idempotencyKey, ok: true, timestamp };
}

function parseBody(rawBody: string): Record<string, unknown> | Response {
  try {
    const body = JSON.parse(rawBody) as unknown;
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {}
  return webhookError(400, "invalid_json", "webhook body must be a JSON object");
}

function normalizeWebhookWorkCreate(
  body: Record<string, unknown>,
  idempotencyKey: string,
  timestamp: string,
  rawBody: string
): NormalizedWebhookWorkCreate | Response {
  if (clean(body.type) !== WORK_CREATE_EVENT) return webhookError(400, "unsupported_event", "webhook event type is unsupported");
  const eventID = required(body.id);
  const occurredAt = timestampValue(body.occurred_at) || timestamp;
  const data = object(body.data);
  const projectID = required(data.project_id);
  const title = required(data.title);
  const goal = required(data.goal);
  const status = clean(data.status) || "triage";
  if (eventID === "" || projectID === "" || title === "" || goal === "") {
    return webhookError(400, "invalid_event", "work.create requires id, data.project_id, data.title and data.goal");
  }
  if (status !== "triage" && status !== "todo") {
    return webhookError(400, "invalid_event", "work.create status must be triage or todo");
  }
  const envelope: InboundEnvelope = {
    audit: {
      action_id: `webhook:${idempotencyKey}`,
      correlation_id: `webhook:${idempotencyKey}`,
      event_ref: `external_event:${idempotencyKey}`,
      idempotency_key: idempotencyKey,
      occurred_at: occurredAt
    },
    connector_id: WEBHOOK_SOURCE,
    event_id: eventID,
    event_type: WORK_CREATE_EVENT,
    occurred_at: occurredAt,
    payload: { goal, project_id: projectID, status, title },
    source: WEBHOOK_SOURCE
  };
  if (!validateInboundEnvelope(envelope, WEBHOOK_CHANNEL_MANIFEST).ok) {
    return webhookError(400, "invalid_event", "webhook event is invalid");
  }
  return {
    envelope,
    goal,
    idempotency_key: idempotencyKey,
    occurred_at: occurredAt,
    project_id: projectID,
    raw_payload_sha256: createHash("sha256").update(rawBody).digest("hex"),
    raw_payload: body,
    status,
    title,
    work_audit: {
      actor: { id: "signed-webhook", kind: "user" },
      correlation_id: `webhook:${idempotencyKey}`,
      event_id: `webhook:${idempotencyKey}`,
      gate: {
        authority: "deterministic_policy",
        decision: "allow",
        policy_ref: "xuanwu-work-webhook-signature-v1"
      },
      occurred_at: occurredAt,
      reason: "signed webhook Work create"
    }
  };
}

function persistInboundEvent(
  db: RunnerDatabase,
  normalized: NormalizedWebhookWorkCreate
): ExternalEventRecord | Response {
  if (!getProject(db, normalized.project_id)) return webhookError(404, "project_not_found", "Project not found");
  const existing = upsertExternalEvent(db, {
    content: normalized.goal,
    dedupe_key: normalized.idempotency_key,
    event_type: normalized.envelope.event_type,
    external_id: normalized.envelope.event_id,
    occurred_at: normalized.occurred_at,
    project_id: normalized.project_id,
    provider: WEBHOOK_SOURCE,
    raw_json: normalized.raw_payload,
    source: WEBHOOK_SOURCE,
    status: "accepted",
    summary: { raw_payload_sha256: normalized.raw_payload_sha256 },
    trust_level: "signed",
    normalized_message: normalized.envelope.payload
  });
  const existingHash = clean(existing.summary.raw_payload_sha256);
  if (existingHash !== "" && existingHash !== normalized.raw_payload_sha256) {
    return webhookError(409, "webhook_idempotency_conflict", "Idempotency-Key conflicts with a different event");
  }
  return existing;
}

function existingWork(db: RunnerDatabase, event: ExternalEventRecord): WorkLedgerEntry | null {
  const link = listExternalLinksByExternal(db, {
    externalID: event.external_id,
    externalType: WORK_CREATE_LINK_TYPE,
    limit: 1,
    source: WEBHOOK_SOURCE
  })[0];
  return link ? getIssueBackedWork(db, `xw:work:issues:${link.issue_id}`) : null;
}

function acceptedResponse(work: WorkLedgerEntry, event: ExternalEventRecord, replayed: boolean): Response {
  return json({
    accepted: true,
    callback: { mode: "poll", status_url: `/api/works/${encodeURIComponent(work.id)}` },
    event: { id: event.id, idempotency_key: event.dedupe_key, source: event.source },
    replayed,
    work
  }, { status: replayed ? 200 : 202 });
}

function issueIDFromWork(work: WorkLedgerEntry): number {
  const match = /^xw:work:issues:([1-9]\d*)$/.exec(work.id);
  if (!match) throw new Error("webhook work must be Issue-backed");
  return Number(match[1]);
}

function webhookError(status: number, code: string, message: string): Response {
  return json({ code, message }, { status });
}

function safeEqual(value: string, expected: string): boolean {
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function validKey(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function required(value: unknown): string {
  return clean(value);
}

function timestampValue(value: unknown): string {
  const text = clean(value);
  return text !== "" && Number.isFinite(Date.parse(text)) ? text : "";
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
