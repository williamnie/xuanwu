import type { RunnerDatabase } from "../db/database.ts";
import {
  upsertExternalEvent,
  type ExternalEventInput,
  type ExternalEventRecord
} from "../db/repositories/externalEvents.ts";

type JsonObject = Record<string, unknown>;

type SyncDefaults = { provider: string; source: string };

export type CliRawEventSyncOptions = {
  defaultProvider?: string;
  defaultSource?: string;
  now?: Date;
};

export type CliRawEventSyncResult = {
  events: ExternalEventRecord[];
  processed_watermark: string;
  source: string;
};

export function syncCliRawEvents(
  db: RunnerDatabase,
  output: unknown,
  options: CliRawEventSyncOptions = {}
): CliRawEventSyncResult {
  const payload = objectValue(output);
  const defaults = syncDefaults(payload, options);
  const events = arrayValue(payload.events)
    .map((event) => upsertExternalEvent(db, eventInput(event, defaults), options.now));
  return {
    events,
    processed_watermark: firstText(payload.processed_watermark, payload.watermark, payload.cursor),
    source: defaults.source
  };
}

function syncDefaults(payload: JsonObject, options: CliRawEventSyncOptions): SyncDefaults {
  const source = firstText(payload.source, options.defaultSource);
  return { provider: firstText(payload.provider, options.defaultProvider, source), source };
}

function eventInput(value: unknown, defaults: SyncDefaults): ExternalEventInput {
  const raw = objectValue(value);
  const sourceRef = firstText(raw.source_ref, raw.sourceRef);
  const externalID = firstText(
    raw.external_id, raw.externalId, raw.message_id, raw.messageId, raw.id,
    externalIDFromSourceRef(sourceRef)
  );
  return {
    actor: firstText(raw.actor, raw.user, raw.sender),
    attachments: attachmentInputs(raw.attachments),
    content: firstText(raw.content, raw.text, raw.message, raw.summary_text),
    dedupe_key: firstText(raw.dedupe_key, raw.dedupeKey, sourceRef, externalID),
    event_type: firstText(raw.event_type, raw.eventType, raw.type),
    external_id: externalID,
    normalized_message: objectValue(raw.normalized_message ?? raw.normalizedMessage),
    occurred_at: firstText(raw.occurred_at, raw.occurredAt, raw.timestamp),
    project_hint: firstText(raw.project_hint, raw.projectHint),
    project_id: firstText(raw.project_id, raw.projectId),
    provider: firstText(raw.provider, defaults.provider),
    raw_json: raw,
    raw_payload_ref: firstText(raw.raw_payload_ref, raw.rawPayloadRef),
    received_at: firstText(raw.received_at, raw.receivedAt),
    source: firstText(raw.source, defaults.source),
    summary: objectValue(raw.summary),
    trust_level: firstText(raw.trust_level, raw.trustLevel)
  };
}

function attachmentInputs(value: unknown): ExternalEventInput["attachments"] {
  return arrayValue(value).map(objectValue) as ExternalEventInput["attachments"];
}

function externalIDFromSourceRef(value: unknown): string {
  const text = firstText(value);
  const separator = text.indexOf(":");
  return separator > 0 ? text.slice(separator + 1).trim() : "";
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = cleanString(value);
    if (text !== "") return text;
  }
  return "";
}

function cleanString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}
