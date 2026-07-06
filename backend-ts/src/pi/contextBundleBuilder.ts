import type {
  ContextBundleCreatedBy,
  ContextBundleEvidenceSummary,
  ContextBundleInput,
  ContextBundleSourceQuery,
  ContextBundleTrigger
} from "../db/repositories/contextBundles.ts";
import type { ExternalEventRecord } from "../db/repositories/externalEvents.ts";

type JsonObject = Record<string, unknown>;

export type ContextBundleBuilderOptions = {
  anchorEventId?: number;
  createdBy: ContextBundleCreatedBy;
  maxEvents?: number;
  source?: string;
  tokenBudget?: number;
  trigger: ContextBundleTrigger;
  windowMinutes?: number;
};

export type ManualContextBundleRequest = {
  created_by: "user";
  reason: string;
  source: string;
  source_query: ContextBundleSourceQuery;
  trigger: "manual";
};

export type ManualContextBundleRequestOptions = {
  defaultLookbackMinutes?: number;
  limit?: number;
  now?: Date;
  source?: string;
  threadKey?: string;
};

const DEFAULT_WINDOW_MINUTES = 15;
const DEFAULT_MAX_EVENTS = 12;
const DEFAULT_TOKEN_BUDGET = 2000;
const DEFAULT_MANUAL_LOOKBACK_MINUTES = 15;
const DEFAULT_MANUAL_LIMIT = 50;
const APPROX_CHARS_PER_TOKEN = 4;

export function buildContextBundleFromEvents(
  events: ExternalEventRecord[],
  options: ContextBundleBuilderOptions
): ContextBundleInput {
  const ordered = sortEvents(events);
  const anchor = findAnchor(ordered, options.anchorEventId);
  if (!anchor) throw new Error("anchor event is required");
  const selected = selectBundleEvents(ordered, anchor, options);
  const attachmentRefs = attachmentRefsForEvents(selected);
  return {
    attachment_refs: attachmentRefs,
    context: evidenceContext(selected, cleanBudget(options.tokenBudget)),
    created_by: options.createdBy,
    event_refs: selected.map((event) => event.id),
    evidence_refs: evidenceRefs(selected, attachmentRefs),
    reason: bundleReason(anchor, options.trigger, attachmentRefs),
    source: cleanString(options.source) || anchor.source,
    token_budget: cleanBudget(options.tokenBudget),
    trigger: options.trigger,
    window: selectedWindow(selected)
  };
}

export function buildManualContextBundleRequest(
  command: string,
  options: ManualContextBundleRequestOptions = {}
): ManualContextBundleRequest {
  const now = options.now ?? new Date();
  const lookback = positiveInteger(options.defaultLookbackMinutes, DEFAULT_MANUAL_LOOKBACK_MINUTES);
  const query = manualSourceQuery(command, now, lookback, options);
  return {
    created_by: "user",
    reason: manualReason(query),
    source: cleanString(options.source),
    source_query: query,
    trigger: "manual"
  };
}

function selectBundleEvents(
  events: ExternalEventRecord[],
  anchor: ExternalEventRecord,
  options: ContextBundleBuilderOptions
): ExternalEventRecord[] {
  const source = cleanString(options.source) || anchor.source;
  const candidates = events.filter((event) => event.source === source && isRelated(event, anchor, options));
  const maxEvents = positiveInteger(options.maxEvents, DEFAULT_MAX_EVENTS);
  return sortEvents(closestEvents(candidates, anchor).slice(0, maxEvents));
}

function isRelated(
  event: ExternalEventRecord,
  anchor: ExternalEventRecord,
  options: ContextBundleBuilderOptions
): boolean {
  if (!withinWindow(event, anchor, options.windowMinutes)) return false;
  const anchorThread = threadKey(anchor);
  if (anchorThread === "") return true;
  return threadKey(event) === anchorThread || replyRelated(event, anchor);
}

function closestEvents(events: ExternalEventRecord[], anchor: ExternalEventRecord): ExternalEventRecord[] {
  return [...events].sort((left, right) => {
    const distance = eventDistance(left, anchor) - eventDistance(right, anchor);
    return distance || occurredMs(left) - occurredMs(right) || left.id - right.id;
  });
}

function evidenceContext(
  events: ExternalEventRecord[],
  tokenBudget: number
): ContextBundleEvidenceSummary[] {
  const maxChars = perEventSummaryChars(events.length, tokenBudget);
  return events.map((event) => ({
    actor: cleanString(event.actor),
    attachment_refs: attachmentRefsForEvent(event),
    event_ref: event.id,
    occurred_at: isoTime(event),
    source_ref: sourceRef(event),
    summary: truncateRunes(summaryText(event), maxChars)
  }));
}

function manualSourceQuery(
  command: string,
  now: Date,
  lookbackMinutes: number,
  options: ManualContextBundleRequestOptions
): ContextBundleSourceQuery {
  const query: ContextBundleSourceQuery = {
    include_messages: true,
    limit: positiveInteger(options.limit, DEFAULT_MANUAL_LIMIT),
    since: new Date(now.getTime() - lookbackMinutes * 60 * 1000).toISOString()
  };
  addManualHints(query, command, options);
  return query;
}

function addManualHints(
  query: ContextBundleSourceQuery,
  command: string,
  options: ManualContextBundleRequestOptions
): void {
  const text = command.trim();
  if (/群|group/i.test(text)) query.channel_hint = "group";
  if (/截图|图片|图像|image|screenshot/i.test(text)) query.attachment_kinds = ["image"];
  const threadKeyValue = cleanString(options.threadKey);
  if (threadKeyValue !== "") query.thread_key = threadKeyValue;
}

function manualReason(query: ContextBundleSourceQuery): string {
  return Array.isArray(query.attachment_kinds)
    ? "manual_recent_attachment_context"
    : "manual_recent_context";
}

function bundleReason(
  anchor: ExternalEventRecord,
  trigger: ContextBundleTrigger,
  attachmentRefs: string[]
): string {
  const parts = [trigger];
  if (threadKey(anchor) !== "") parts.push("thread");
  parts.push("time_window");
  if (attachmentRefs.length > 0) parts.push("attachment_context");
  return [...new Set(parts)].join("_");
}

function evidenceRefs(events: ExternalEventRecord[], attachmentRefs: string[]): string[] {
  return [...events.map((event) => `external_event:${event.id}`), ...attachmentRefs];
}

function attachmentRefsForEvents(events: ExternalEventRecord[]): string[] {
  return events.flatMap(attachmentRefsForEvent);
}

function attachmentRefsForEvent(event: ExternalEventRecord): string[] {
  return event.attachments.map((_, index) => `external_event:${event.id}#attachment:${index}`);
}

function selectedWindow(events: ExternalEventRecord[]): { from: string; to: string } {
  const times = events.map(occurredMs).filter(Number.isFinite);
  return {
    from: new Date(Math.min(...times)).toISOString(),
    to: new Date(Math.max(...times)).toISOString()
  };
}

function withinWindow(
  event: ExternalEventRecord,
  anchor: ExternalEventRecord,
  windowMinutes: number | undefined
): boolean {
  const windowMs = positiveInteger(windowMinutes, DEFAULT_WINDOW_MINUTES) * 60 * 1000;
  return Math.abs(occurredMs(event) - occurredMs(anchor)) <= windowMs;
}

function replyRelated(event: ExternalEventRecord, anchor: ExternalEventRecord): boolean {
  const anchorExternalID = cleanString(anchor.external_id);
  const eventExternalID = cleanString(event.external_id);
  return replyTarget(event) === anchorExternalID || replyTarget(anchor) === eventExternalID;
}

function replyTarget(event: ExternalEventRecord): string {
  const message = objectValue(event.normalized_message);
  return firstText(message.reply_to_external_id, message.reply_to_message_id, message.parent_id);
}

function threadKey(event: ExternalEventRecord): string {
  const message = objectValue(event.normalized_message);
  return firstText(message.thread_key, message.thread_id, message.root_id);
}

function sourceRef(event: ExternalEventRecord): string {
  return event.external_id ? `${event.source}:${event.external_id}` : `external_event:${event.id}`;
}

function summaryText(event: ExternalEventRecord): string {
  const content = cleanString(event.content).replace(/\s+/g, " ");
  return content || `[${event.attachments.length} attachment metadata item(s)]`;
}

function perEventSummaryChars(eventCount: number, tokenBudget: number): number {
  const count = Math.max(eventCount, 1);
  return Math.max(1, Math.ceil((tokenBudget * APPROX_CHARS_PER_TOKEN) / count));
}

function truncateRunes(value: string, maxRunes: number): string {
  const runes = [...value];
  if (runes.length <= maxRunes) return value;
  if (maxRunes <= 1) return "…";
  return `${runes.slice(0, maxRunes - 1).join("")}…`;
}

function findAnchor(events: ExternalEventRecord[], anchorID: number | undefined): ExternalEventRecord | null {
  if (events.length === 0) return null;
  if (!anchorID) return events.at(-1) ?? null;
  return events.find((event) => event.id === anchorID) ?? null;
}

function sortEvents(events: ExternalEventRecord[]): ExternalEventRecord[] {
  return [...events].sort((left, right) => occurredMs(left) - occurredMs(right) || left.id - right.id);
}

function eventDistance(event: ExternalEventRecord, anchor: ExternalEventRecord): number {
  return Math.abs(occurredMs(event) - occurredMs(anchor));
}

function isoTime(event: ExternalEventRecord): string {
  return new Date(occurredMs(event)).toISOString();
}

function occurredMs(event: ExternalEventRecord): number {
  const value = Date.parse(event.occurred_at || event.received_at);
  return Number.isFinite(value) ? value : 0;
}

function cleanBudget(value: unknown): number {
  return positiveInteger(value, DEFAULT_TOKEN_BUDGET);
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function firstText(...values: unknown[]): string {
  return values.map(cleanString).find(Boolean) ?? "";
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}
