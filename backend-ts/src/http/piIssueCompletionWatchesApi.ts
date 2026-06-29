import type { RunnerDatabase } from "../db/database.ts";
import {
  cancelPiIssueCompletionWatch,
  getPiIssueCompletionWatch,
  listPiIssueCompletionWatchNotifications,
  listPiIssueCompletionWatches,
  type PiIssueCompletionWatch,
  type PiIssueCompletionWatchNotification
} from "../db/repositories/pi.ts";
import { HttpError, json } from "./errors.ts";
import type { Router } from "./router.ts";

type CompletionWatchContext = { database: RunnerDatabase };

export function registerPiIssueCompletionWatchRoutes(
  router: Router,
  context: CompletionWatchContext
): void {
  router.get("/api/pi/issue-completion-watches", (request) => listResponse(context, request));
  router.get("/api/pi/issue-completion-watches/:id", (request) => detailResponse(context, request));
  router.post("/api/pi/issue-completion-watches/:id/cancel", (request) => cancelResponse(context, request));
}

function listResponse(context: CompletionWatchContext, request: Request): Response {
  const filter = listFilter(request);
  const items = listPiIssueCompletionWatches(context.database, filter).map(watchSummary);
  return json({ count: items.length, filters: filter, items, limit: filter.limit });
}

function detailResponse(context: CompletionWatchContext, request: Request): Response {
  const watch = requireWatch(context.database, watchID(request));
  return json(watchDetail(context.database, watch));
}

async function cancelResponse(context: CompletionWatchContext, request: Request): Promise<Response> {
  const watch = cancelPiIssueCompletionWatch(context.database, watchID(request), await cancelReason(request));
  return json(watchDetail(context.database, watch));
}

function watchDetail(db: RunnerDatabase, watch: PiIssueCompletionWatch): Record<string, unknown> {
  return {
    ...watchSummary(watch),
    condition: safeJson(watch.condition),
    error: watch.error,
    idempotency_key: watch.idempotency_key,
    items: watch.items,
    notifications: listPiIssueCompletionWatchNotifications(db, watch.id).map(notificationSummary),
    origin_conversation_id: watch.origin_conversation_id,
    requested_by: watch.requested_by,
    source_event_id: watch.source_event_id,
    source_message_id: watch.source_message_id
  };
}

function watchSummary(watch: PiIssueCompletionWatch): Record<string, unknown> {
  return {
    completed_at: watch.completed_at,
    created_at: watch.created_at,
    id: watch.id,
    issue_count: watch.items.length,
    notified_at: watch.notified_at,
    project_id: watch.project_id,
    status: watch.status,
    target: watchTarget(watch),
    updated_at: watch.updated_at
  };
}

function notificationSummary(row: PiIssueCompletionWatchNotification): Record<string, unknown> {
  return {
    error: row.intent.error,
    id: row.intent.id,
    kind: row.intent.kind,
    outbox: row.outbox ? outboxSummary(row.outbox) : null,
    ready_at: row.intent.ready_at,
    sent_at: row.intent.sent_at,
    sent_outbox_id: row.intent.sent_outbox_id,
    state: row.intent.state,
    summary: row.intent.summary
  };
}

function outboxSummary(outbox: PiIssueCompletionWatchNotification["outbox"]): Record<string, unknown> | null {
  if (!outbox) return null;
  return {
    attempt_count: outbox.attempt_count,
    cooldown_until: outbox.cooldown_until,
    feishu_message_id: outbox.feishu_message_id,
    id: outbox.id,
    last_error: outbox.last_error,
    sent_at: outbox.sent_at,
    status: outbox.status
  };
}

function listFilter(request: Request): { limit: number; projectId: string; status: string } {
  const params = new URL(request.url).searchParams;
  return {
    limit: positiveLimit(params.get("limit")),
    projectId: cleanString(params.get("project_id") ?? params.get("projectId")),
    status: cleanString(params.get("status"))
  };
}

async function cancelReason(request: Request): Promise<string> {
  const text = await request.text();
  if (text.trim() === "") return "cancelled_by_api";
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    return cleanString(body.reason) || "cancelled_by_api";
  } catch {
    throw new HttpError(400, "请求体不是合法 JSON");
  }
}

function requireWatch(db: RunnerDatabase, id: string): PiIssueCompletionWatch {
  const watch = getPiIssueCompletionWatch(db, id);
  if (!watch) throw new HttpError(404, "completion watch not found");
  return watch;
}

function watchID(request: Request): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const raw = parts[parts.indexOf("issue-completion-watches") + 1] ?? "";
  const id = decodeURIComponent(raw).trim();
  if (id === "") throw new HttpError(400, "watch id 不能为空");
  return id;
}

function watchTarget(watch: PiIssueCompletionWatch): Record<string, string> {
  return {
    channel: watch.target_channel,
    chat_id: watch.target_chat_id,
    message_id: watch.target_message_id,
    thread_id: watch.target_thread_id
  };
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value || "{}"); } catch { return value; }
}

function positiveLimit(value: unknown): number {
  const number = Number.parseInt(cleanString(value), 10);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, 100) : 20;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
