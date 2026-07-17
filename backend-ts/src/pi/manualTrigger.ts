import type { RunnerDatabase } from "../db/database.ts";
import {
  createContextBundle,
  type ContextBundleRecord,
  type ContextBundleSourceQuery
} from "../db/repositories/contextBundles.ts";
import { listExternalEvents, type ExternalEventRecord } from "../db/repositories/externalEvents.ts";
import type { AttentionInboxItemRecord, IntakeRunRecord } from "../db/repositories/intakeRuns.ts";
import type { PiAction } from "../db/repositories/pi.ts";
import {
  buildContextBundleFromEvents,
  buildManualContextBundleRequest,
  type ManualContextBundleRequest
} from "./contextBundleBuilder.ts";
import { runDomainSkillAndMarkProposal } from "./domainSkillRun.ts";
import { runIntakeSkill, type LlmIntakeOutput, type LlmIntakeRequest } from "./llmIntake.ts";
import {
  listManualSourcePullSources,
  pullManualSourceEvents,
  type ManualSourcePullOptions,
  type ManualSourcePullResult
} from "./manualSourcePull.ts";

type JsonObject = Record<string, unknown>;

export type ManualContextIntakeInput = {
  attachment_kinds?: string[];
  conversation_id?: string;
  cursor?: string;
  limit?: number;
  lookback_minutes?: number;
  message_id?: string;
  now?: Date | string;
  project_id?: string;
  require_attachments?: boolean;
  source?: string;
  source_provider_id?: string;
  source_turn_id?: string;
  source_turn_source?: string;
  source_tool_name?: string;
  thread_key?: string;
  user_prompt?: string;
};

export type ManualContextIntakeResult = {
  bundle?: ContextBundleRecord;
  inbox_items?: AttentionInboxItemRecord[];
  intake_run?: IntakeRunRecord;
  proposal_actions?: PiAction[];
  reason: string;
  request?: ManualContextBundleRequest;
  status: "needs_user" | "succeeded";
  text: string;
};

const DEFAULT_LOOKBACK_MINUTES = 15;
const DEFAULT_LIMIT = 50;
const SOURCE_SCAN_LIMIT = 500;
const MAX_BUNDLE_EVENTS = 12;
const TOKEN_BUDGET = 2000;

export async function runManualContextIntake(
  db: RunnerDatabase,
  input: ManualContextIntakeInput,
  options: ManualSourcePullOptions = {}
): Promise<ManualContextIntakeResult> {
  const prompt = cleanString(input.user_prompt);
  const pullSources = listManualSourcePullSources(db, options);
  const allowExplicitPull = cleanString(input.source_provider_id) !== "" || cleanString(input.source_tool_name) !== "";
  const resolved = resolveManualSource(db, input.source, prompt, pullSources, allowExplicitPull);
  if (!resolved.source) return needsUser(resolved.reason, sourceHelp(resolved.reason, resolved.sources));
  const now = normalizeNow(input.now);
  let source = resolved.source;
  let request = manualRequest(input, prompt, source, now);
  let selected = selectManualEvents(db, request.source_query, source);
  if (!selected.anchor) {
    const pulled = await pullRecentManualSource(db, input, request, source, now, options);
    if (pulled.status === "needs_user") return needsUser(pulled.reason, pulled.text, request);
    source = pulled.source;
    request = requestWithPullResult(request, pulled);
    selected = selectManualEvents(db, request.source_query, source);
  }
  if (!selected.anchor) return needsUser("context_not_found", contextHelp(source, selected.reason), request);
  const bundle = persistManualBundle(db, request, selected.events, selected.anchor, now);
  const intake = await runIntakeSkill(db, bundle, (llmRequest) => manualIntakeModel(llmRequest, input), {
    model: "manual-trigger-intake"
  });
  const domainRuns = await Promise.all(intake.created_items.map((item) => runDomainSkillAndMarkProposal(db, item)));
  const proposals = domainRuns.map((run) => run.action);
  return {
    bundle,
    inbox_items: intake.created_items,
    intake_run: intake.run,
    proposal_actions: proposals,
    reason: "manual_context_intake_completed",
    request,
    status: "succeeded",
    text: successText(bundle, intake.created_items, proposals)
  };
}

async function pullRecentManualSource(
  db: RunnerDatabase,
  input: ManualContextIntakeInput,
  request: ManualContextBundleRequest,
  source: string,
  now: Date,
  options: ManualSourcePullOptions
): Promise<ManualSourcePullResult> {
  return pullManualSourceEvents(db, {
    attachmentKinds: stringList(request.source_query.attachment_kinds),
    cursor: cleanString(input.cursor),
    limit: positiveInteger(input.limit, DEFAULT_LIMIT),
    messageID: cleanString(input.message_id),
    now,
    providerID: cleanString(input.source_provider_id),
    query: request.source_query,
    requireAttachments: input.require_attachments === true,
    source,
    threadKey: cleanString(input.thread_key),
    toolName: cleanString(input.source_tool_name)
  }, options);
}

function requestWithPullResult(
  request: ManualContextBundleRequest,
  pulled: Extract<ManualSourcePullResult, { status: "succeeded" }>
): ManualContextBundleRequest {
  return {
    ...request,
    source: pulled.source,
    source_query: cleanObject({
      ...request.source_query,
      processed_watermark: pulled.processed_watermark,
      source_pull: {
        event_count: pulled.event_count,
        provider_id: pulled.provider_id,
        status: pulled.status,
        tool_name: pulled.tool_name
      }
    })
  };
}

function manualRequest(
  input: ManualContextIntakeInput,
  prompt: string,
  source: string,
  now: Date
): ManualContextBundleRequest {
  const lookback = lookbackMinutes(input, prompt);
  const base = buildManualContextBundleRequest(prompt, {
    defaultLookbackMinutes: lookback,
    limit: positiveInteger(input.limit, DEFAULT_LIMIT),
    now,
    source,
    threadKey: input.thread_key
  });
  return { ...base, source_query: sourceQueryWithHints({ ...base.source_query, lookback_minutes: lookback }, input, prompt) };
}

function persistManualBundle(
  db: RunnerDatabase,
  request: ManualContextBundleRequest,
  events: ExternalEventRecord[],
  anchor: ExternalEventRecord,
  now: Date
): ContextBundleRecord {
  const lookback = lookbackFromQuery(request.source_query);
  const input = buildContextBundleFromEvents(events, {
    anchorEventId: anchor.id,
    createdBy: request.created_by,
    maxEvents: MAX_BUNDLE_EVENTS,
    source: request.source,
    tokenBudget: TOKEN_BUDGET,
    trigger: request.trigger,
    windowMinutes: lookback
  });
  return createContextBundle(db, {
    ...input,
    reason: request.reason,
    source_query: request.source_query
  }, now);
}

function selectManualEvents(
  db: RunnerDatabase,
  query: ContextBundleSourceQuery,
  source: string
): { anchor?: ExternalEventRecord; events: ExternalEventRecord[]; reason: string } {
  const all = listExternalEvents(db, { limit: SOURCE_SCAN_LIMIT, source });
  const events = chronological(all.filter((event) => eventMatchesQuery(event, query)));
  const anchor = anchorEvent(events, query);
  return { anchor, events, reason: anchor ? "" : missingContextReason(all, events, query) };
}

function manualIntakeModel(request: LlmIntakeRequest, input: ManualContextIntakeInput): LlmIntakeOutput {
  const projectID = cleanString(input.project_id);
  const prompt = cleanString(input.user_prompt);
  const evidence = request.bundle.evidence_refs.length > 0 ? request.bundle.evidence_refs : [];
  return {
    ignored_groups: [],
    inbox_items: [{
      actor_refs: [],
      confidence: projectID === "" && wantsIssue(prompt) ? 0.68 : 0.82,
      evidence_refs: evidence,
      intents: { primary: primaryIntent(prompt, projectID), secondary: secondaryIntents(prompt), tags: ["manual_trigger"] },
      suggested_actions: suggestedActions(prompt, projectID),
      summary: manualSummary(request.bundle, prompt, projectID),
      target_hints: projectID === "" ? [] : [projectHint(projectID)],
      title: manualTitle(request.bundle, prompt),
      urgency: urgency(prompt)
    }]
  };
}

function resolveManualSource(
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

function sourceQueryWithHints(
  query: ContextBundleSourceQuery,
  input: ManualContextIntakeInput,
  prompt: string
): ContextBundleSourceQuery {
  return cleanObject({
    ...query,
    attachment_kinds: attachmentKinds(query, input, prompt),
    cursor: cleanString(input.cursor),
    manual_trigger: manualTriggerMetadata(input, prompt),
    message_id: cleanString(input.message_id),
    source_turn_id: cleanString(input.source_turn_id)
  });
}

function eventMatchesQuery(event: ExternalEventRecord, query: ContextBundleSourceQuery): boolean {
  if (!withinSince(event, query.since)) return false;
  if (!matchesThread(event, query.thread_key)) return false;
  if (!matchesMessage(event, query.message_id)) return false;
  if (!matchesChannel(event, query.channel_hint)) return false;
  return true;
}

function anchorEvent(events: ExternalEventRecord[], query: ContextBundleSourceQuery): ExternalEventRecord | undefined {
  const messageID = cleanString(query.message_id);
  const exact = messageID === "" ? undefined : events.find((event) => matchesMessage(event, messageID));
  if (exact) return exact;
  const attachmentKinds = stringList(query.attachment_kinds);
  const candidates = attachmentKinds.length === 0 ? events : events.filter((event) => hasAttachmentKind(event, attachmentKinds));
  return candidates.at(-1);
}

function missingContextReason(
  all: ExternalEventRecord[],
  events: ExternalEventRecord[],
  query: ContextBundleSourceQuery
): string {
  if (all.length === 0) return "source_has_no_events";
  if (events.length === 0) return "no_events_in_requested_window_or_thread";
  if (stringList(query.attachment_kinds).length > 0) return "requested_attachment_not_found";
  return "context_not_found";
}

function lookbackMinutes(input: ManualContextIntakeInput, prompt: string): number {
  const explicit = positiveInteger(input.lookback_minutes, 0);
  if (explicit > 0) return explicit;
  const minutes = firstNumber(prompt, /(\d+)\s*(?:分钟|mins?|minutes?)/i);
  if (minutes > 0) return minutes;
  const hours = firstNumber(prompt, /(\d+)\s*(?:小时|钟头|hours?|hrs?)/i);
  if (hours > 0) return hours * 60;
  if (/今天|today/i.test(prompt)) return 24 * 60;
  return DEFAULT_LOOKBACK_MINUTES;
}

function attachmentKinds(
  query: ContextBundleSourceQuery,
  input: ManualContextIntakeInput,
  prompt: string
): string[] | undefined {
  const explicit = stringList(input.attachment_kinds);
  if (explicit.length > 0) return explicit;
  const existing = stringList(query.attachment_kinds);
  if (existing.length > 0) return existing;
  return input.require_attachments || /截图|图片|图像|image|screenshot/i.test(prompt) ? ["image"] : undefined;
}

function manualTriggerMetadata(input: ManualContextIntakeInput, prompt: string): JsonObject {
  return cleanObject({
    conversation_id: cleanString(input.conversation_id),
    project_id: cleanString(input.project_id),
    source: cleanString(input.source_turn_source),
    source_turn_id: cleanString(input.source_turn_id),
    user_prompt: prompt
  });
}

function manualSummary(bundle: ContextBundleRecord, prompt: string, projectID: string): string {
  const context = bundle.context.map((item) => item.summary).filter(Boolean).join(" / ");
  const projectNote = projectID === "" && wantsIssue(prompt) ? "目标 project 不明确，需要先向用户确认。" : "";
  return [prompt, context, projectNote].filter(Boolean).join("\n");
}

function manualTitle(bundle: ContextBundleRecord, prompt: string): string {
  const text = prompt || bundle.context.map((item) => item.summary).find(Boolean) || "Manual context intake";
  return truncate(text.replace(/\s+/g, " "), 80);
}

function primaryIntent(prompt: string, projectID: string): LlmIntakeOutput["inbox_items"][number]["intents"]["primary"] {
  if (projectID === "" && wantsIssue(prompt)) return "other";
  if (/bug|报错|错误|异常|500|error|fail/i.test(prompt)) return "bug_report";
  if (/回复|reply/i.test(prompt)) return "reply_needed";
  if (/跟进|追踪|follow/i.test(prompt)) return "follow_up";
  return "other";
}

function suggestedActions(prompt: string, projectID: string): string[] {
  if (projectID === "" && wantsIssue(prompt)) return ["ask_user"];
  if (wantsIssue(prompt)) return ["triage_attention_item", "create_issue_proposal"];
  if (/回复|reply/i.test(prompt)) return ["message.reply_draft"];
  return ["triage_attention_item"];
}

function secondaryIntents(prompt: string): string[] {
  const intents: string[] = [];
  if (/创建|建个|issue|任务|task/i.test(prompt)) intents.push("create_task");
  if (/回复|reply/i.test(prompt)) intents.push("reply_needed");
  return intents;
}

function projectHint(projectID: string): {
  confidence: number;
  id: string;
  kind: string;
  reason: string;
} {
  return { confidence: 0.8, id: projectID, kind: "project", reason: "manual trigger target project" };
}

function urgency(prompt: string): "high" | "low" | "medium" {
  if (/紧急|马上|urgent|asap/i.test(prompt)) return "high";
  return "medium";
}

function wantsIssue(prompt: string): boolean {
  return /issue|创建|建个|开个|任务|bug|报错|错误|error/i.test(prompt);
}

function contextHelp(source: string, reason: string): string {
  if (reason === "requested_attachment_not_found") return `已找到 ${source} 的消息，但没有匹配的附件；请放宽附件条件或补充消息位置。`;
  if (reason === "source_has_no_events") return `来源 ${source} 还没有可用上下文；请先授权或同步该来源。`;
  return `没有在 ${source} 找到匹配的最近上下文；请补充时间、thread/message 或重新授权同步。`;
}

function sourceHelp(reason: string, sources: string[]): string {
  if (reason === "source_unavailable_or_needs_authorization") return "指定来源不可用，可能需要先授权或同步。";
  return sources.length === 0 ? "需要先指定并授权一个上下文来源。" : `请指定来源：${sources.join(", ")}。`;
}

function successText(bundle: ContextBundleRecord, items: AttentionInboxItemRecord[], actions: PiAction[]): string {
  const actionTypes = actions.map((action) => action.action_type).join(", ") || "none";
  return `已读取 ${bundle.source} 最近上下文，形成 context bundle #${bundle.id}、intake item ${items.length} 个、proposal ${actions.length} 个（${actionTypes}）。`;
}

function needsUser(reason: string, text: string, request?: ManualContextBundleRequest): ManualContextIntakeResult {
  return { reason, request, status: "needs_user", text };
}

function listExternalEventSources(db: RunnerDatabase): string[] {
  return db.sqlite.query<{ source: string }, []>(
    "select distinct source from external_events where source<>'' order by source asc"
  ).all().map((row) => row.source.trim()).filter(Boolean);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(cleanString).filter(Boolean))].sort();
}

function withinSince(event: ExternalEventRecord, value: unknown): boolean {
  const since = Date.parse(cleanString(value));
  if (!Number.isFinite(since)) return true;
  return eventTime(event) >= since;
}

function matchesThread(event: ExternalEventRecord, value: unknown): boolean {
  const wanted = cleanString(value);
  return wanted === "" || threadKey(event) === wanted;
}

function matchesMessage(event: ExternalEventRecord, value: unknown): boolean {
  const wanted = cleanString(value);
  return wanted === "" || event.external_id === wanted || cleanString(event.normalized_message.message_id) === wanted;
}

function matchesChannel(event: ExternalEventRecord, value: unknown): boolean {
  const wanted = cleanString(value).toLowerCase();
  const chatType = cleanString(event.normalized_message.chat_type).toLowerCase();
  return wanted !== "group" || chatType === "" || chatType.includes("group");
}

function hasAttachmentKind(event: ExternalEventRecord, kinds: string[]): boolean {
  return event.attachments.some((attachment) => kinds.includes(cleanString(attachment.kind).toLowerCase()));
}

function threadKey(event: ExternalEventRecord): string {
  const message = event.normalized_message;
  return firstText(message.thread_key, message.thread_id, message.root_id);
}

function chronological(events: ExternalEventRecord[]): ExternalEventRecord[] {
  return [...events].sort((left, right) => eventTime(left) - eventTime(right) || left.id - right.id);
}

function eventTime(event: ExternalEventRecord): number {
  return Date.parse(event.occurred_at || event.received_at);
}

function lookbackFromQuery(query: ContextBundleSourceQuery): number {
  const explicit = positiveInteger(query.lookback_minutes, 0);
  if (explicit > 0) return explicit;
  const since = Date.parse(cleanString(query.since));
  if (!Number.isFinite(since)) return DEFAULT_LOOKBACK_MINUTES;
  return Math.max(1, Math.ceil((Date.now() - since) / 60_000));
}

function firstNumber(text: string, pattern: RegExp): number {
  const value = Number(pattern.exec(text)?.[1] ?? 0);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function normalizeNow(value: Date | string | undefined): Date {
  if (value instanceof Date) return value;
  const parsed = Date.parse(cleanString(value));
  return Number.isFinite(parsed) ? new Date(parsed) : new Date();
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => cleanString(item).toLowerCase()).filter(Boolean) : [];
}

function cleanObject(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => !emptyValue(child)));
}

function emptyValue(value: unknown): boolean {
  return value === "" || value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function firstText(...values: unknown[]): string {
  return values.map(cleanString).find(Boolean) ?? "";
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
