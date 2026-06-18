import type { RunnerDatabase } from "../db/database.ts";
import { redactAuditText } from "../db/repositories/pi/auditRedaction.ts";
import {
  getPiRunGroup,
  listPiNotificationIntents,
  listPiRunGroupItems,
  listPiRunGroups,
  type PiNotificationIntent,
  type PiRunGroup,
  type PiRunGroupItem
} from "../db/repositories/pi.ts";
import { flushRunGroupDigest, runDigestFlushSchedulerOnce } from "../pi/digestFlushScheduler.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import { registerPiGuardianPreferenceRoutes } from "./piGuardianPreferencesApi.ts";
import type { Router } from "./router.ts";

type PiGuardianContext = { database: RunnerDatabase };
type BucketCounts = Record<string, number>;
type DigestCounts = {
  active: number; completed: number; failed: number; needs_user: number;
  skipped: number; total: number; verification: number;
};

export function registerPiGuardianRoutes(router: Router, context: PiGuardianContext): void {
  router.get("/api/pi/guardian/run-groups", (request) => json(runGroupsResponse(context.database, request)));
  router.get("/api/pi/guardian/run-groups/:id", (request) => json(runGroupDetailResponse(context.database, request)));
  router.get("/api/pi/guardian/notification-intents", (request) => json(notificationIntentsResponse(context.database, request)));
  registerPiGuardianPreferenceRoutes(router, context);
  router.post("/api/pi/guardian/digest/flush", async (request) => json(
    await digestFlushResponse(context.database, request)
  ));
}

function runGroupsResponse(db: RunnerDatabase, request: Request): unknown[] {
  const params = new URL(request.url).searchParams;
  return listPiRunGroups(db, {
    projectId: clean(params.get("project_id") ?? params.get("projectId")),
    status: clean(params.get("status"))
  }).map((group) => runGroupSummary(db, group, undefined, false));
}

function runGroupDetailResponse(db: RunnerDatabase, request: Request): unknown {
  const group = getPiRunGroup(db, runGroupID(request));
  if (!group) throw new HttpError(404, "资源不存在");
  const items = listPiRunGroupItems(db, group.id);
  return {
    ...runGroupSummary(db, group, items, true),
    items: items.map(itemSummary)
  };
}

function notificationIntentsResponse(db: RunnerDatabase, request: Request): unknown[] {
  const params = new URL(request.url).searchParams;
  return listPiNotificationIntents(db, {
    issueId: positiveID(params.get("issue_id") ?? params.get("issueId")),
    kind: clean(params.get("kind")),
    projectId: clean(params.get("project_id") ?? params.get("projectId")),
    runGroupId: clean(params.get("run_group_id") ?? params.get("runGroupId")),
    state: clean(params.get("state"))
  }).map(intentSummary);
}

function runGroupSummary(
  db: RunnerDatabase,
  group: PiRunGroup,
  cachedItems?: PiRunGroupItem[],
  includeIntentDetails = false
): Record<string, unknown> {
  const items = cachedItems ?? listPiRunGroupItems(db, group.id);
  const intents = listPiNotificationIntents(db, { runGroupId: group.id });
  const pendingFailedIntents = pendingFailedNotificationIntents(intents);
  return {
    completed_at: group.completed_at,
    created_at: group.created_at,
    deadline_at: group.deadline_at,
    digest_flush_sequence: group.digest_flush_sequence,
    expected_issue_count: group.expected_issue_count,
    id: group.id,
    item_buckets: itemBuckets(items, group.expected_issue_count),
    items_count: items.length,
    last_digest: lastDigestSummary(intents),
    last_digest_at: group.last_digest_at,
    max_interval_minutes: group.max_interval_minutes,
    origin_conversation_id: group.origin_conversation_id,
    pending_failed_intent_count: pendingFailedIntents.length,
    ...(includeIntentDetails ? { pending_failed_intents: pendingFailedIntents.map(intentSummary) } : {}),
    project_id: group.project_id,
    status: group.status,
    updated_at: group.updated_at,
    user_phrase: safeText(group.user_phrase)
  };
}

function itemSummary(item: PiRunGroupItem): Record<string, unknown> {
  return {
    completed_at: item.completed_at,
    enqueue_action_id: item.enqueue_action_id,
    enqueue_status: item.enqueue_status,
    final_issue_status: item.final_issue_status,
    issue_id: item.issue_id,
    issue_title_snapshot: safeText(item.issue_title_snapshot),
    joined_at: item.joined_at,
    position: item.position,
    report_bucket: item.report_bucket,
    report_reason: safeText(item.report_reason),
    report_status: item.report_status,
    reportable_at: item.reportable_at,
    status: item.status,
    updated_at: item.updated_at
  };
}

function intentSummary(intent: PiNotificationIntent): Record<string, unknown> {
  return {
    ack_required: intent.ack_required,
    ack_status: intent.ack_status,
    conversation_id: intent.conversation_id,
    created_at: intent.created_at,
    decision: intent.decision,
    error: safeText(intent.error),
    flush_after_at: intent.flush_after_at,
    flush_bucket: intent.flush_bucket,
    flush_reason: intent.flush_reason,
    flush_sequence: intent.flush_sequence,
    id: intent.id,
    issue_id: intent.issue_id,
    kind: intent.kind,
    payload_summary: payloadSummary(intent),
    project_id: intent.project_id,
    ready_at: intent.ready_at,
    requires_user: intent.requires_user,
    run_group_id: intent.run_group_id,
    sent_at: intent.sent_at,
    sent_outbox_id: intent.sent_outbox_id,
    severity: intent.severity,
    source_event_sequence_id: intent.source_event_sequence_id,
    source_event_type: intent.source_event_type,
    state: intent.state,
    summary: safeText(intent.summary),
    target_channel: intent.target_channel,
    updated_at: intent.updated_at
  };
}

function itemBuckets(items: PiRunGroupItem[], expectedCount: number): BucketCounts {
  const counts: BucketCounts = { active: Math.max(expectedCount - items.length, 0) };
  for (const item of items) counts[item.report_bucket || "active"] = (counts[item.report_bucket || "active"] ?? 0) + 1;
  return counts;
}

function lastDigestSummary(intents: PiNotificationIntent[]): Record<string, unknown> | null {
  const digest = intents.filter((intent) => intent.kind === "digest")
    .sort((left, right) => digestSortKey(right).localeCompare(digestSortKey(left)))[0];
  if (!digest) return null;
  const payload = payloadSummary(digest);
  return {
    counts: record(payload.counts),
    flush_reason: digest.flush_reason,
    flush_sequence: digest.flush_sequence,
    id: digest.id,
    issues: Array.isArray(payload.issues) ? payload.issues : [],
    ready_at: digest.ready_at,
    sent_at: digest.sent_at,
    sent_outbox_id: digest.sent_outbox_id,
    state: digest.state,
    summary: safeText(digest.summary)
  };
}

function pendingFailedNotificationIntents(intents: PiNotificationIntent[]): PiNotificationIntent[] {
  return intents.filter((intent) => intent.kind !== "digest" && (
    ["pending", "ready"].includes(intent.state) || intent.error !== ""
  ));
}

function payloadSummary(intent: PiNotificationIntent): Record<string, unknown> {
  const payload = parseRecord(intent.payload_json);
  if (intent.kind === "digest") {
    return {
      counts: digestCounts(payload),
      issues: safeIssueBuckets(payload.issues)
    };
  }
  return {
    keys: Object.keys(payload).filter((key) => key !== "raw" && key !== "raw_payload").sort()
  };
}

function digestCounts(payload: Record<string, unknown>): DigestCounts {
  return {
    active: numberField(payload, "active_count", "active"),
    completed: numberField(payload, "completed_count", "completed"),
    failed: numberField(payload, "failed_count", "failed"),
    needs_user: numberField(payload, "needs_user_count", "needsUser"),
    skipped: numberField(payload, "skipped_count", "skipped"),
    total: numberField(payload, "total_count", "total"),
    verification: numberField(payload, "verification_count", "verification")
  };
}

function safeIssueBuckets(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((item) => {
    const row = record(item);
    return {
      bucket: safeText(text(row.bucket)),
      issue_id: positiveNumber(row.issue_id),
      reason: safeText(text(row.reason)),
      status: safeText(text(row.status)),
      title: safeText(text(row.title))
    };
  }).filter((item) => item.issue_id > 0);
}

async function digestFlushResponse(db: RunnerDatabase, request: Request): Promise<unknown> {
  const body = await optionalObjectBody(request);
  const runGroupID = clean(body.run_group_id) || clean(body.runGroupId);
  if (runGroupID !== "") return flushRunGroupDigest(db, { now: clean(body.now), runGroupID });
  return runDigestFlushSchedulerOnce(db, digestFlushInput(body));
}

function digestFlushInput(body: Record<string, unknown>): { limit?: number; now?: string } {
  const input: { limit?: number; now?: string } = {};
  const limit = positiveNumber(body.limit);
  const now = clean(body.now);
  if (limit > 0) input.limit = limit;
  if (now !== "") input.now = now;
  return input;
}

async function optionalObjectBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await parseJsonBody(request);
    return record(body);
  } catch (error) {
    if (error instanceof HttpError) return {};
    throw error;
  }
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    return record(JSON.parse(value || "{}") as unknown);
  } catch {
    return {};
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function digestSortKey(intent: PiNotificationIntent): string {
  return [
    padded(intent.flush_sequence),
    intent.sent_at,
    intent.ready_at,
    intent.created_at,
    intent.id
  ].join("|");
}

function padded(value: number): string {
  return String(value).padStart(10, "0");
}

function numberField(payload: Record<string, unknown>, primary: string, legacy: string): number {
  return positiveNumber(payload[primary]) || positiveNumber(payload[legacy]);
}

function positiveID(value: string | null): number | undefined {
  const id = positiveNumber(value);
  return id > 0 ? id : undefined;
}

function positiveNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(clean(value));
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function runGroupID(request: Request): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const value = parts[parts.indexOf("run-groups") + 1]?.trim() ?? "";
  if (value === "") throw new HttpError(400, "run group id 不能为空");
  return decodeURIComponent(value);
}

function safeText(value: string): string {
  return redactAuditText(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
