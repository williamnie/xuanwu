import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../db/database.ts";
import type { ExternalEventRecord } from "../db/repositories/externalEvents.ts";
import { listProjects } from "../db/repositories/projects.ts";
import type { EventBus } from "../events/bus.ts";
import { decidePiAttention, type PiAttentionDecision } from "../pi/attentionRouter.ts";
import {
  normalizeFeishuMessageEvent,
  type FeishuConnectorConfig,
  type FeishuNormalizedMessageEvent
} from "./feishu.ts";
import { feishuInboundEnvelopeForEvent } from "./feishuChannelConnector.ts";
import { ingestImInboundEnvelope } from "./imInboundService.ts";

export type FeishuIngestContext = {
  bus?: EventBus;
  config: FeishuConnectorConfig;
  database?: RunnerDatabase;
};

export type FeishuIngestMeta = {
  encrypted?: boolean;
  rawPayloadRef?: string;
  transport: "callback" | "websocket";
};

export type FeishuIngestResult = {
  dedupe_key: string;
  event_id: number;
  normalized_summary: Record<string, unknown>;
  ok: true;
};

type AuditPayload = {
  connector: "feishu";
  dedupe_key?: string;
  encrypted?: boolean;
  normalized_summary?: Record<string, unknown>;
  outcome: "accepted" | "challenge" | "received" | "rejected";
  raw_payload_ref: string;
  reason: string;
  transport: "callback" | "websocket";
};

export function ingestFeishuMessageEvent(
  raw: unknown,
  context: FeishuIngestContext,
  meta: FeishuIngestMeta
): FeishuIngestResult {
  const rawRef = meta.rawPayloadRef || rawPayloadRef(raw);
  const event = normalizeFeishuMessageEvent(raw, { rawEventRef: rawRef });
  const attention = attentionDecision(context, event);
  const envelope = feishuInboundEnvelopeForEvent(event, attention.project_id);
  const summary = normalizedSummary(event, attention.project_id, attention);
  // The Feishu adapter owns normalization; the provider-neutral service is the
  // single durable writer. Do not instantiate a second connector per event.
  const inboxEvent: ExternalEventRecord | null = context.database
    ? ingestImInboundEnvelope(context.database, envelope, {
      projectId: attention.project_id,
      raw,
      status: inboxStatus("", attention),
      summary: { ...summary, attention_decision: attention }
    })
    : null;
  publishAudit(context, {
    connector: "feishu",
    dedupe_key: event.dedupe_key,
    encrypted: meta.encrypted,
    normalized_summary: summary,
    outcome: "accepted",
    raw_payload_ref: rawRef,
    reason: "message_normalized",
    transport: meta.transport
  });
  return {
    dedupe_key: event.dedupe_key,
    event_id: inboxEvent?.id ?? 0,
    normalized_summary: summary,
    ok: true
  };
}

export function publishFeishuAudit(context: FeishuIngestContext, payload: AuditPayload): void {
  publishAudit(context, payload);
}

export function rawPayloadRef(raw: unknown): string {
  return `sha256:${createHash("sha256").update(rawPayloadText(raw)).digest("hex")}`;
}

function rawPayloadText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw) ?? "";
  } catch {
    return String(raw);
  }
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

function attentionDecision(context: FeishuIngestContext, event: FeishuNormalizedMessageEvent): PiAttentionDecision {
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
  return decision;
}

function inboxStatus(current: unknown, attention: PiAttentionDecision): string {
  if (attention.decision === "ignore") return "ignored";
  if (attention.decision === "ask_clarification") return "needs_project";
  if (attention.decision === "blocked_by_policy") return "blocked_by_policy";
  if (attention.decision === "inbox_only") return "inbox_only";
  return typeof current === "string" && current.trim() !== "" ? current.trim() : "mapped";
}

function publishAudit(context: FeishuIngestContext, payload: AuditPayload): void {
  context.bus?.publish({ payload: JSON.stringify(payload), type: "integration.feishu.audit" });
}
