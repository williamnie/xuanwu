import type { RunnerDatabase } from "../db/database.ts";
import type { ContextBundleRecord } from "../db/repositories/contextBundles.ts";
import { getExternalEvent, type ExternalEventAttachment, type ExternalEventRecord } from "../db/repositories/externalEvents.ts";
import { retrievePiMemoryContext, type PiMemoryRetrievalResult } from "./memoryContext.ts";

type JsonObject = Record<string, unknown>;

export type IntakeSkillAttachmentInput = {
  evidence_ref: string;
  kind: string;
  mime_type: string;
  name: string;
  ocr_text: string;
  vision_summary: string;
};

export type IntakeSkillEventInput = {
  actor: string;
  attachment_refs: string[];
  attachments: IntakeSkillAttachmentInput[];
  event_ref: number;
  event_type: string;
  evidence_ref: string;
  occurred_at: string;
  raw_event_summary: JsonObject;
  source_ref: string;
  summary: string;
  trust_level: string;
};

export type IntakeSkillInput = {
  context_retrieval: PiMemoryRetrievalResult;
  context_bundle: {
    attachment_refs: string[];
    created_by: string;
    evidence_refs: string[];
    id: number;
    raw_event_summaries: IntakeSkillEventInput[];
    reason: string;
    source: string;
    source_query: JsonObject;
    token_budget: number;
    trigger: string;
    window: JsonObject;
  };
};

export function buildIntakeSkillInput(db: RunnerDatabase, bundle: ContextBundleRecord): IntakeSkillInput {
  const events = bundle.event_refs.map((id) => eventInput(db, bundle, id)).filter(Boolean) as IntakeSkillEventInput[];
  return {
    context_retrieval: retrievePiMemoryContext(db, {
      limit: 8,
      projectID: projectIDFromBundle(bundle),
      sourceID: bundle.source,
      tokenBudget: 700
    }),
    context_bundle: {
      attachment_refs: bundle.attachment_refs,
      created_by: bundle.created_by,
      evidence_refs: bundle.evidence_refs,
      id: bundle.id,
      raw_event_summaries: events,
      reason: bundle.reason,
      source: bundle.source,
      source_query: bundle.source_query,
      token_budget: bundle.token_budget,
      trigger: bundle.trigger,
      window: bundle.window
    }
  };
}

export function buildIntakeSkillPrompt(input: JsonObject): string {
  return [
    "You are the Xuanwu Supervisor intake skill runtime.",
    "Classify this controlled context bundle into attention inbox items or ignored groups.",
    "Return only JSON matching the provided schema.",
    "Use top-level keys inbox_items and ignored_groups.",
    "Do not request external writes or execute actions; only identify intake results.",
    "Use raw_event_summaries and attachment OCR/vision summaries as evidence.",
    "Use context_retrieval.memory_items only as traceable, scoped memory hints; keep evidence_refs tied to source events.",
    "Do not assume access to raw payloads, attachment files, or hidden source content.",
    JSON.stringify(input, null, 2)
  ].join("\n");
}

function eventInput(
  db: RunnerDatabase,
  bundle: ContextBundleRecord,
  eventID: number
): IntakeSkillEventInput | null {
  const event = getExternalEvent(db, eventID);
  const summary = bundle.context.find((item) => item.event_ref === eventID);
  if (!event && !summary) return null;
  return event ? hydratedEvent(event, summary) : summaryOnlyEvent(bundle, summary!, eventID);
}

function hydratedEvent(
  event: ExternalEventRecord,
  summary: ContextBundleRecord["context"][number] | undefined
): IntakeSkillEventInput {
  const attachmentRefs = attachmentRefsForEvent(event);
  return {
    actor: summary?.actor || event.actor,
    attachment_refs: attachmentRefs,
    attachments: event.attachments.map((attachment, index) => attachmentInput(event.id, index, attachment)),
    event_ref: event.id,
    event_type: event.event_type,
    evidence_ref: `external_event:${event.id}`,
    occurred_at: summary?.occurred_at || event.occurred_at,
    raw_event_summary: rawEventSummary(event, summary?.summary),
    source_ref: summary?.source_ref || sourceRef(event),
    summary: summary?.summary || contentSummary(event),
    trust_level: event.trust_level
  };
}

function summaryOnlyEvent(
  bundle: ContextBundleRecord,
  summary: ContextBundleRecord["context"][number],
  eventID: number
): IntakeSkillEventInput {
  return {
    actor: summary.actor,
    attachment_refs: summary.attachment_refs,
    attachments: [],
    event_ref: eventID,
    event_type: "message",
    evidence_ref: `external_event:${eventID}`,
    occurred_at: summary.occurred_at,
    raw_event_summary: { summary: summary.summary },
    source_ref: summary.source_ref || `${bundle.source}:event-${eventID}`,
    summary: summary.summary,
    trust_level: "untrusted"
  };
}

function attachmentInput(
  eventID: number,
  index: number,
  attachment: ExternalEventAttachment
): IntakeSkillAttachmentInput {
  return {
    evidence_ref: `external_event:${eventID}#attachment:${index}`,
    kind: attachment.kind,
    mime_type: attachment.mime_type,
    name: attachment.name,
    ocr_text: attachment.ocr_text,
    vision_summary: attachment.vision_summary
  };
}

function rawEventSummary(event: ExternalEventRecord, fallback: string | undefined): JsonObject {
  if (Object.keys(event.summary).length > 0) return event.summary;
  return {
    attachment_count: event.attachments.length,
    content_summary: fallback || contentSummary(event),
    event_type: event.event_type
  };
}

function projectIDFromBundle(bundle: ContextBundleRecord): string {
  const query = bundle.source_query;
  return firstText(query.project_id, query.projectId, objectValue(query.manual_trigger).project_id);
}

function attachmentRefsForEvent(event: ExternalEventRecord): string[] {
  return event.attachments.map((_, index) => `external_event:${event.id}#attachment:${index}`);
}

function sourceRef(event: ExternalEventRecord): string {
  return event.external_id ? `${event.source}:${event.external_id}` : `external_event:${event.id}`;
}

function contentSummary(event: ExternalEventRecord): string {
  return event.content.replace(/\s+/g, " ").trim();
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}
