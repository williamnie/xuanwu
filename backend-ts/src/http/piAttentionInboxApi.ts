import type { RunnerDatabase } from "../db/database.ts";
import { getContextBundle, listContextBundles } from "../db/repositories/contextBundles.ts";
import { getExternalEvent, listExternalEvents } from "../db/repositories/externalEvents.ts";
import {
  createIntakeRun,
  getAttentionInboxItem,
  getIntakeRun,
  listAttentionInboxItems,
  listIntakeRuns,
  updateAttentionInboxItemStatus,
  type AttentionInboxItemRecord,
  type AttentionInboxItemStatus,
  type IntakeRunRecord
} from "../db/repositories/intakeRuns.ts";
import { runDomainSkillAndMarkProposal } from "../pi/domainSkillRun.ts";
import { publicIntakeRun } from "./piSkillRunViews.ts";
import { redactAuditText } from "../db/repositories/pi/auditRedaction.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

type AttentionInboxContext = { database: RunnerDatabase };
type JsonObject = Record<string, unknown>;

const ITEM_STATUSES = new Set(["new", "triaged", "proposal_created", "actioned", "ignored", "failed"]);
const RUN_STATUSES = new Set(["running", "succeeded", "failed"]);

export function registerPiAttentionInboxRoutes(router: Router, context: AttentionInboxContext): void {
  router.get("/api/pi/attention-inbox/raw-events", (request) => json(rawEventList(context, request)));
  router.get("/api/pi/attention-inbox/raw-events/:id", (request) => rawEventResponse(context, request));
  router.get("/api/pi/attention-inbox/context-bundles", (request) => json(contextBundleList(context, request)));
  router.get("/api/pi/attention-inbox/context-bundles/:id", (request) => contextBundleResponse(context, request));
  router.get("/api/pi/attention-inbox/intake-runs", (request) => json(intakeRunList(context, request)));
  router.get("/api/pi/attention-inbox/intake-runs/:id", (request) => intakeRunResponse(context, request));
  router.get("/api/pi/attention-inbox/items", (request) => json(inboxItemList(context, request)));
  router.get("/api/pi/attention-inbox/items/:id", (request) => inboxItemResponse(context, request));
  router.patch("/api/pi/attention-inbox/items/:id", (request) => patchInboxItem(context, request));
  router.post("/api/pi/attention-inbox/items/:id/ignore", (request) => ignoreInboxItem(context, request));
  router.post("/api/pi/attention-inbox/items/:id/reintake", (request) => reintakeInboxItem(context, request));
  router.post("/api/pi/attention-inbox/items/:id/domain-skill", (request) => domainSkillProposal(context, request));
}

function rawEventList(context: AttentionInboxContext, request: Request): unknown[] {
  const params = new URL(request.url).searchParams;
  return listExternalEvents(context.database, {
    limit: queryInt(params.get("limit")),
    source: cleanParam(params.get("source"))
  }).map(compactRawEvent);
}

function rawEventResponse(context: AttentionInboxContext, request: Request): Response {
  const event = getExternalEvent(context.database, pathID(request, "raw-events"));
  if (!event) throw new HttpError(404, "raw event not found");
  return json(event);
}

function contextBundleList(context: AttentionInboxContext, request: Request): unknown[] {
  const params = new URL(request.url).searchParams;
  return listContextBundles(
    context.database,
    cleanParam(params.get("source")),
    queryInt(params.get("limit")) ?? 100
  ).map(compactContextBundle);
}

function contextBundleResponse(context: AttentionInboxContext, request: Request): Response {
  const bundle = getContextBundle(context.database, pathID(request, "context-bundles"));
  if (!bundle) throw new HttpError(404, "context bundle not found");
  return json(bundle);
}

function intakeRunList(context: AttentionInboxContext, request: Request): unknown[] {
  const params = new URL(request.url).searchParams;
  return listIntakeRuns(context.database, {
    bundleId: queryInt(params.get("bundle_id") || params.get("bundleId")),
    limit: queryInt(params.get("limit")),
    status: runStatus(params.get("status"))
  }).map(compactIntakeRun);
}

function intakeRunResponse(context: AttentionInboxContext, request: Request): Response {
  const run = getIntakeRun(context.database, pathID(request, "intake-runs"));
  if (!run) throw new HttpError(404, "intake run not found");
  return json(publicIntakeRun(run));
}

function inboxItemList(context: AttentionInboxContext, request: Request): unknown[] {
  const params = new URL(request.url).searchParams;
  return listAttentionInboxItems(context.database, {
    intakeRunId: queryInt(params.get("intake_run_id") || params.get("intakeRunId")),
    limit: queryInt(params.get("limit")),
    source: cleanParam(params.get("source")),
    status: cleanParam(params.get("status"))
  }).map(compactInboxItem);
}

function inboxItemResponse(context: AttentionInboxContext, request: Request): Response {
  const item = requireInboxItem(context, request);
  return json({ ...item, links: itemLinks(item) });
}

async function patchInboxItem(context: AttentionInboxContext, request: Request): Promise<Response> {
  const body = await objectBody(request);
  return json(updateAttentionInboxItemStatus(context.database, pathID(request, "items"), itemStatus(body.status)));
}

function ignoreInboxItem(context: AttentionInboxContext, request: Request): Response {
  return json(updateAttentionInboxItemStatus(context.database, pathID(request, "items"), "ignored"));
}

function reintakeInboxItem(context: AttentionInboxContext, request: Request): Response {
  const item = requireInboxItem(context, request);
  const previous = requireIntakeRun(context.database, item.intake_run_id);
  const run = createIntakeRun(context.database, {
    bundle_id: item.bundle_id,
    input_summary: retrySummary(item, previous),
    model: previous.model,
    model_policy_id: previous.model_policy_id,
    skill_id: previous.skill_id,
    status: "running"
  });
  return json({ created: true, item_id: item.id, run }, { status: 202 });
}

async function domainSkillProposal(context: AttentionInboxContext, request: Request): Promise<Response> {
  const item = requireInboxItem(context, request);
  const result = await runDomainSkillAndMarkProposal(context.database, item);
  return json({ action: result.action, item: result.item, proposal: result.proposal, proposal_status: "created" }, { status: 202 });
}

function compactInboxItem(item: AttentionInboxItemRecord): JsonObject {
  return {
    id: item.id,
    source: item.source,
    bundle_id: item.bundle_id,
    intake_run_id: item.intake_run_id,
    title: item.title,
    summary: item.summary,
    status: item.status,
    primary_intent: item.primary_intent,
    secondary_intents: item.secondary_intents,
    suggested_actions: item.suggested_actions,
    confidence: item.confidence,
    urgency: item.urgency,
    evidence_refs: item.evidence_refs,
    project_hints: projectHints(item),
    created_at: item.created_at,
    updated_at: item.updated_at
  };
}

function compactRawEvent(event: ReturnType<typeof listExternalEvents>[number]): JsonObject {
  return {
    id: event.id,
    source: event.source,
    provider: event.provider,
    external_id: event.external_id,
    event_type: event.event_type,
    occurred_at: event.occurred_at,
    received_at: event.received_at,
    actor: event.actor,
    project_hint: event.project_hint,
    project_id: event.project_id,
    status: event.status,
    trust_level: event.trust_level,
    content: event.content,
    attachment_count: event.attachments.length,
    raw_payload_ref: event.raw_payload_ref
  };
}

function compactContextBundle(bundle: ReturnType<typeof listContextBundles>[number]): JsonObject {
  return {
    id: bundle.id,
    source: bundle.source,
    event_refs: bundle.event_refs,
    attachment_refs: bundle.attachment_refs,
    evidence_refs: bundle.evidence_refs,
    reason: bundle.reason,
    trigger: bundle.trigger,
    created_by: bundle.created_by,
    token_budget: bundle.token_budget,
    window: bundle.window,
    created_at: bundle.created_at
  };
}

function compactIntakeRun(run: IntakeRunRecord): JsonObject {
  return {
    id: run.id,
    bundle_id: run.bundle_id,
    skill_id: run.skill_id,
    model: run.model,
    status: run.status,
    error: redactAuditText(run.error),
    ignored_count: run.ignored_groups.length,
    created_at: run.created_at,
    updated_at: run.updated_at
  };
}

function itemLinks(item: AttentionInboxItemRecord): JsonObject {
  return {
    context_bundle: `/api/pi/attention-inbox/context-bundles/${item.bundle_id}`,
    intake_run: `/api/pi/attention-inbox/intake-runs/${item.intake_run_id}`,
    raw_events: eventIDs(item.evidence_refs).map((id) => `/api/pi/attention-inbox/raw-events/${id}`)
  };
}

function retrySummary(item: AttentionInboxItemRecord, previous: IntakeRunRecord): JsonObject {
  return {
    item_id: item.id,
    previous_intake_run_id: previous.id,
    reason: "manual_reintake_requested",
    source: item.source,
    title: item.title
  };
}

function projectHints(item: AttentionInboxItemRecord): JsonObject[] {
  return item.target_hints.filter((hint) => cleanString(hint.kind) === "project");
}

function eventIDs(refs: string[]): number[] {
  return [...new Set(refs.map((ref) => /^external_event:(\d+)/.exec(ref)?.[1]).filter(Boolean).map(Number))];
}

function requireInboxItem(context: AttentionInboxContext, request: Request): AttentionInboxItemRecord {
  const item = getAttentionInboxItem(context.database, pathID(request, "items"));
  if (!item) throw new HttpError(404, "attention inbox item not found");
  return item;
}

function requireIntakeRun(db: RunnerDatabase, id: number): IntakeRunRecord {
  const run = getIntakeRun(db, id);
  if (!run) throw new HttpError(404, "intake run not found");
  return run;
}

async function objectBody(request: Request): Promise<JsonObject> {
  const body = await parseJsonBody(request);
  return body && typeof body === "object" && !Array.isArray(body) ? body as JsonObject : {};
}

function pathID(request: Request, segment: string): number {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const raw = parts[parts.indexOf(segment) + 1] ?? "";
  if (!/^\d+$/.test(raw)) throw new HttpError(400, `${segment} id 不合法`);
  return Number(raw);
}

function itemStatus(value: unknown): AttentionInboxItemStatus {
  const status = cleanString(value);
  if (!ITEM_STATUSES.has(status)) throw new HttpError(400, "attention inbox status 不合法");
  return status as AttentionInboxItemStatus;
}

function runStatus(value: string | null): "running" | "succeeded" | "failed" | undefined {
  const status = cleanParam(value);
  if (status === "") return undefined;
  if (!RUN_STATUSES.has(status)) throw new HttpError(400, "intake run status 不合法");
  return status as "running" | "succeeded" | "failed";
}

function queryInt(value: string | null): number | undefined {
  const text = cleanParam(value);
  if (!/^\d+$/.test(text)) return undefined;
  const number = Number(text);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function cleanParam(value: string | null): string {
  return value?.trim() ?? "";
}
function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
