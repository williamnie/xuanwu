import {
  approveImReplyDraft,
  getImReplyDraft,
  listImReplyDrafts,
  listSyncOutbox,
  rejectImReplyDraft
} from "../db/repositories/imReplyOutbox.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { HttpError, json } from "./errors.ts";
import type { Router } from "./router.ts";

type ImReplyOutboxContext = { database: RunnerDatabase };

export function registerImReplyOutboxRoutes(router: Router, context: ImReplyOutboxContext): void {
  router.get("/api/im-reply-drafts", (request) => json(listImReplyDrafts(context.database, queryFilter(request))));
  router.get("/api/im-reply-drafts/:id", (request) => draftResponse(context, request));
  router.post("/api/im-reply-drafts/:id/approve", (request) => approveResponse(context, request));
  router.post("/api/im-reply-drafts/:id/reject", async (request) => rejectResponse(context, request));
  router.get("/api/sync-outbox", (request) => json(listSyncOutbox(context.database, queryFilter(request))));
}

function draftResponse(context: ImReplyOutboxContext, request: Request): Response {
  const draft = getImReplyDraft(context.database, draftID(request));
  if (!draft) throw new HttpError(404, "im reply draft not found");
  return json(draft);
}

function approveResponse(context: ImReplyOutboxContext, request: Request): Response {
  try {
    return json(approveImReplyDraft(context.database, draftID(request)));
  } catch (error) {
    throw outboxHttpError(error);
  }
}

async function rejectResponse(context: ImReplyOutboxContext, request: Request): Promise<Response> {
  const body = await optionalObjectBody(request);
  try {
    return json(rejectImReplyDraft(context.database, draftID(request), {
      reason: cleanString(body.reason || body.rejection_reason)
    }));
  } catch (error) {
    throw outboxHttpError(error);
  }
}

async function optionalObjectBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.trim() === "") return {};
  try {
    const body = JSON.parse(text);
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch {
    throw new HttpError(400, "请求体不是合法 JSON");
  }
}

function queryFilter(request: Request): { source: string; status: string } {
  const params = new URL(request.url).searchParams;
  return { source: cleanString(params.get("source")), status: cleanString(params.get("status")) };
}

function draftID(request: Request): number {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const raw = parts[parts.indexOf("im-reply-drafts") + 1] ?? "";
  if (!/^[0-9]+$/.test(raw)) throw new HttpError(400, "im reply draft id 不合法");
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "im reply draft id 不合法");
  return id;
}

function outboxHttpError(error: unknown): HttpError {
  if (error instanceof Error && error.message.includes("not found")) return new HttpError(404, error.message);
  if (error instanceof Error) return new HttpError(409, error.message);
  return new HttpError(400, "im reply outbox operation failed");
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
