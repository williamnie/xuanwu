import type { RunnerDatabase } from "../../db/database.ts";
import { type ContextBundleRecord, type ContextBundleSourceQuery } from "../../db/repositories/contextBundles.ts";
import { type ExternalEventRecord } from "../../db/repositories/externalEvents.ts";
import { type ManualContextBundleRequest } from "./contextBundleBuilder.ts";
import { cleanString } from "../../util/values.ts";
import { type ManualContextIntakeInput, DEFAULT_LOOKBACK_MINUTES, JsonObject, ManualContextIntakeResult } from "./manualTrigger.ts";

export function resolveManualSource(
  db: RunnerDatabase,
  requested: unknown,
  prompt: string,
  pullSources: string[] = [],
  allowExplicitPull = false
): { reason: string; source: string; sources: string[] } {
  const sources = uniqueStrings([...listExternalEventSources(db), ...pullSources]);
  const explicit = cleanString(requested);
  if (explicit !== "" && allowExplicitPull) return { reason: "", source: explicit, sources };
  if (explicit !== "") return sources.includes(explicit)
    ? { reason: "", source: explicit, sources }
    : { reason: "source_unavailable_or_needs_authorization", source: "", sources };
  const mentioned = sources.filter((source) => prompt.toLowerCase().includes(source.toLowerCase()));
  if (mentioned.length === 1) return { reason: "", source: mentioned[0], sources };
  if (sources.length === 1) return { reason: "", source: sources[0], sources };
  return { reason: "source_required", source: "", sources };
}

export function sourceQueryWithHints(
  query: ContextBundleSourceQuery,
  input: ManualContextIntakeInput,
  prompt: string
): ContextBundleSourceQuery {
  return cleanObject({
    ...query,
    attachment_kinds: attachmentKinds(query, input),
    cursor: cleanString(input.cursor),
    manual_trigger: manualTriggerMetadata(input, prompt),
    message_id: cleanString(input.message_id),
    source_turn_id: cleanString(input.source_turn_id)
  });
}

export function eventMatchesQuery(event: ExternalEventRecord, query: ContextBundleSourceQuery): boolean {
  if (!withinSince(event, query.since)) return false;
  if (!matchesThread(event, query.thread_key)) return false;
  if (!matchesMessage(event, query.message_id)) return false;
  if (!matchesChannel(event, query.channel_hint)) return false;
  return true;
}

export function anchorEvent(events: ExternalEventRecord[], query: ContextBundleSourceQuery): ExternalEventRecord | undefined {
  const messageID = cleanString(query.message_id);
  const exact = messageID === "" ? undefined : events.find((event) => matchesMessage(event, messageID));
  if (exact) return exact;
  const attachmentKinds = stringList(query.attachment_kinds);
  const candidates = attachmentKinds.length === 0 ? events : events.filter((event) => hasAttachmentKind(event, attachmentKinds));
  return candidates.at(-1);
}

export function missingContextReason(
  all: ExternalEventRecord[],
  events: ExternalEventRecord[],
  query: ContextBundleSourceQuery
): string {
  if (all.length === 0) return "source_has_no_events";
  if (events.length === 0) return "no_events_in_requested_window_or_thread";
  if (stringList(query.attachment_kinds).length > 0) return "requested_attachment_not_found";
  return "context_not_found";
}

export function lookbackMinutes(input: ManualContextIntakeInput): number {
  const explicit = positiveInteger(input.lookback_minutes, 0);
  return explicit > 0 ? explicit : DEFAULT_LOOKBACK_MINUTES;
}

export function attachmentKinds(
  query: ContextBundleSourceQuery,
  input: ManualContextIntakeInput
): string[] | undefined {
  const explicit = stringList(input.attachment_kinds);
  if (explicit.length > 0) return explicit;
  const existing = stringList(query.attachment_kinds);
  if (existing.length > 0) return existing;
  return input.require_attachments ? ["image"] : undefined;
}

export function manualTriggerMetadata(input: ManualContextIntakeInput, prompt: string): JsonObject {
  return cleanObject({
    conversation_id: cleanString(input.conversation_id),
    project_id: cleanString(input.project_id),
    source: cleanString(input.source_turn_source),
    source_turn_id: cleanString(input.source_turn_id),
    user_prompt: prompt
  });
}

export function contextHelp(source: string, reason: string): string {
  if (reason === "requested_attachment_not_found") return `已找到 ${source} 的消息，但没有匹配的附件；请放宽附件条件或补充消息位置。`;
  if (reason === "source_has_no_events") return `来源 ${source} 还没有可用上下文；请先授权或同步该来源。`;
  return `没有在 ${source} 找到匹配的最近上下文；请补充时间、thread/message 或重新授权同步。`;
}

export function sourceHelp(reason: string, sources: string[]): string {
  if (reason === "source_unavailable_or_needs_authorization") return "指定来源不可用，可能需要先授权或同步。";
  return sources.length === 0 ? "需要先指定并授权一个上下文来源。" : `请指定来源：${sources.join(", ")}。`;
}

export function successText(bundle: ContextBundleRecord): string {
  return `已读取 ${bundle.source} 最近上下文，形成 context bundle #${bundle.id}；请由 PI 根据 bundle 内容决定是否追问或调用后续工具。`;
}

export function needsUser(reason: string, text: string, request?: ManualContextBundleRequest): ManualContextIntakeResult {
  return { reason, request, status: "needs_user", text };
}

export function listExternalEventSources(db: RunnerDatabase): string[] {
  return db.sqlite.query<{ source: string }, []>(
    "select distinct source from external_events where source<>'' order by source asc"
  ).all().map((row) => row.source.trim()).filter(Boolean);
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(cleanString).filter(Boolean))].sort();
}

export function withinSince(event: ExternalEventRecord, value: unknown): boolean {
  const since = Date.parse(cleanString(value));
  if (!Number.isFinite(since)) return true;
  return eventTime(event) >= since;
}

export function matchesThread(event: ExternalEventRecord, value: unknown): boolean {
  const wanted = cleanString(value);
  return wanted === "" || threadKey(event) === wanted;
}

export function matchesMessage(event: ExternalEventRecord, value: unknown): boolean {
  const wanted = cleanString(value);
  return wanted === "" || event.external_id === wanted || cleanString(event.normalized_message.message_id) === wanted;
}

export function matchesChannel(event: ExternalEventRecord, value: unknown): boolean {
  const wanted = cleanString(value).toLowerCase();
  const chatType = cleanString(event.normalized_message.chat_type).toLowerCase();
  return wanted !== "group" || chatType === "" || chatType.includes("group");
}

export function hasAttachmentKind(event: ExternalEventRecord, kinds: string[]): boolean {
  return event.attachments.some((attachment) => kinds.includes(cleanString(attachment.kind).toLowerCase()));
}

export function threadKey(event: ExternalEventRecord): string {
  const message = event.normalized_message;
  return firstText(message.thread_key, message.thread_id, message.root_id);
}

export function chronological(events: ExternalEventRecord[]): ExternalEventRecord[] {
  return [...events].sort((left, right) => eventTime(left) - eventTime(right) || left.id - right.id);
}

export function eventTime(event: ExternalEventRecord): number {
  return Date.parse(event.occurred_at || event.received_at);
}

export function lookbackFromQuery(query: ContextBundleSourceQuery): number {
  const explicit = positiveInteger(query.lookback_minutes, 0);
  if (explicit > 0) return explicit;
  const since = Date.parse(cleanString(query.since));
  if (!Number.isFinite(since)) return DEFAULT_LOOKBACK_MINUTES;
  return Math.max(1, Math.ceil((Date.now() - since) / 60_000));
}

export function normalizeNow(value: Date | string | undefined): Date {
  if (value instanceof Date) return value;
  const parsed = Date.parse(cleanString(value));
  return Number.isFinite(parsed) ? new Date(parsed) : new Date();
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => cleanString(item).toLowerCase()).filter(Boolean) : [];
}

export function cleanObject(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => !emptyValue(child)));
}

export function emptyValue(value: unknown): boolean {
  return value === "" || value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

export function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function firstText(...values: unknown[]): string {
  return values.map(cleanString).find(Boolean) ?? "";
}
