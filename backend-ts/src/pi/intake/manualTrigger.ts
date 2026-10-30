import type { RunnerDatabase } from "../../db/database.ts";
import { createContextBundle, type ContextBundleRecord, type ContextBundleSourceQuery } from "../../db/repositories/contextBundles.ts";
import { listExternalEvents, type ExternalEventRecord } from "../../db/repositories/externalEvents.ts";
import { buildContextBundleFromEvents, buildManualContextBundleRequest, type ManualContextBundleRequest } from "./contextBundleBuilder.ts";
import { listManualSourcePullSources, pullManualSourceEvents, type ManualSourcePullOptions, type ManualSourcePullResult } from "./manualSourcePull.ts";
import { cleanString } from "../../util/values.ts";
import { resolveManualSource, needsUser, sourceHelp, normalizeNow, contextHelp, successText, attachmentKinds, stringList, positiveInteger, threadKey, cleanObject, lookbackMinutes, sourceQueryWithHints, lookbackFromQuery, chronological, eventMatchesQuery, anchorEvent, missingContextReason } from "./manualTriggerSource.ts";

export type JsonObject = Record<string, unknown>;

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
  reason: string;
  request?: ManualContextBundleRequest;
  status: "needs_user" | "succeeded";
  text: string;
};

export const DEFAULT_LOOKBACK_MINUTES = 15;

export const DEFAULT_LIMIT = 50;

export const SOURCE_SCAN_LIMIT = 500;

export const MAX_BUNDLE_EVENTS = 12;

export const TOKEN_BUDGET = 2000;

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
  return {
    bundle,
    reason: "manual_context_bundle_ready",
    request,
    status: "succeeded",
    text: successText(bundle)
  };
}

export async function pullRecentManualSource(
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

export function requestWithPullResult(
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

export function manualRequest(
  input: ManualContextIntakeInput,
  prompt: string,
  source: string,
  now: Date
): ManualContextBundleRequest {
  const lookback = lookbackMinutes(input);
  const base = buildManualContextBundleRequest(prompt, {
    defaultLookbackMinutes: lookback,
    limit: positiveInteger(input.limit, DEFAULT_LIMIT),
    now,
    source,
    threadKey: input.thread_key
  });
  return { ...base, source_query: sourceQueryWithHints({ ...base.source_query, lookback_minutes: lookback }, input, prompt) };
}

export function persistManualBundle(
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

export function selectManualEvents(
  db: RunnerDatabase,
  query: ContextBundleSourceQuery,
  source: string
): { anchor?: ExternalEventRecord; events: ExternalEventRecord[]; reason: string } {
  const all = listExternalEvents(db, { limit: SOURCE_SCAN_LIMIT, source });
  const events = chronological(all.filter((event) => eventMatchesQuery(event, query)));
  const anchor = anchorEvent(events, query);
  return { anchor, events, reason: anchor ? "" : missingContextReason(all, events, query) };
}
