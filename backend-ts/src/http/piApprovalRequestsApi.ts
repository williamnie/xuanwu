import type { RunnerDatabase } from "../db/database.ts";
import { listPiApprovalRequests } from "../db/repositories/pi.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { resolvePiApprovalRequestFromFeishu } from "../integrations/feishuNotifications.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

type PiApprovalRequestsContext = {
  database: RunnerDatabase;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};

export function registerPiApprovalRequestRoutes(router: Router, context: PiApprovalRequestsContext): void {
  router.get("/api/pi/approval-requests", (request) => json(listApprovalRequests(context.database, request)));
  router.post("/api/pi/approval-requests/:id/resolve", async (request) => json(
    await resolveApprovalRequest(context, approvalRequestID(request), await objectBody(request))
  ));
}

function listApprovalRequests(db: RunnerDatabase, request: Request) {
  const params = new URL(request.url).searchParams;
  const status = clean(params.get("status"));
  const rows = listPiApprovalRequests(db, {
    issueId: positiveID(params.get("issue_id")),
    projectId: clean(params.get("project_id")),
    provider: clean(params.get("provider")),
    runId: clean(params.get("run_id")),
    sessionId: clean(params.get("session_id") ?? params.get("sessionId")),
    threadId: clean(params.get("thread_id") ?? params.get("threadId"))
  });
  if (status === "open") return rows.filter((row) => row.status === "pending" || row.status === "delivered");
  if (status !== "") return rows.filter((row) => row.status === status);
  return rows;
}

async function resolveApprovalRequest(
  context: PiApprovalRequestsContext,
  requestID: string,
  body: Record<string, unknown>
) {
  try {
    return await resolvePiApprovalRequestFromFeishu(context.database, {
      decision: clean(body.decision),
      provider: context.providers?.codex,
      requestID,
      scope: clean(body.scope)
    });
  } catch (error) {
    throw new HttpError(409, safeError(error));
  }
}

async function objectBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await parseJsonBody(request);
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function approvalRequestID(request: Request): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const value = parts[parts.indexOf("approval-requests") + 1]?.trim() ?? "";
  if (value === "") throw new HttpError(400, "PI approval request id 不能为空");
  return decodeURIComponent(value);
}

function positiveID(value: string | null): number | undefined {
  const text = clean(value);
  if (text === "") return undefined;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "PI approval request failed";
}
