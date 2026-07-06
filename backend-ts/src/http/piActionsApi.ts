import type { RunnerDatabase } from "../db/database.ts";
import {
  getPiAction,
  listPiActionEvents,
  listPiActions,
  type PiActionFilter
} from "../db/repositories/pi.ts";
import type { EventBus } from "../events/bus.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import type { ProjectLoopStarter } from "./piActionDispatch.ts";
import { executeApprovedPiAction, resolvePiActionDecision } from "./piActionDecision.ts";
import type { Router } from "./router.ts";

type PiActionsContext = {
  bus?: EventBus;
  database: RunnerDatabase;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  startProjectLoop?: ProjectLoopStarter;
};

export function registerPiActionRoutes(router: Router, context: PiActionsContext): void {
  router.get("/api/pi/actions", (request) => json(listPiActions(context.database, piActionFilter(request))));
  router.get("/api/pi/actions/:id", (request) => actionResponse(context, request));
  router.get("/api/pi/actions/:id/events", (request) => json(listPiActionEvents(context.database, { actionId: actionID(request) })));
  router.get("/api/pi/audit-events", (request) => json(listPiActionEvents(context.database, piActionEventFilter(request))));
  router.post("/api/pi/actions/:id/approve", async (request) => json(await approveAction(context, actionID(request))));
  router.post("/api/pi/actions/:id/reject", async (request) => json(await rejectAction(context, actionID(request))));
  router.post("/api/pi/actions/:id/request-changes", async (request) => json(await requestChangesAction(context, actionID(request), request)));
  router.post("/api/pi/actions/:id/snooze", async (request) => json(await snoozeAction(context, actionID(request), request)));
  router.post("/api/pi/actions/:id/execute", async (request) => json(await executeAction(context, actionID(request))));
}

function actionResponse(context: PiActionsContext, request: Request): Response {
  const action = getPiAction(context.database, actionID(request));
  if (!action) throw new HttpError(404, "PI action 不存在");
  return json(action);
}

async function approveAction(context: PiActionsContext, id: string) {
  return await resolvePiActionDecision(context, { actionID: id, decision: "approve" });
}

async function rejectAction(context: PiActionsContext, id: string) {
  return await resolvePiActionDecision(context, { actionID: id, decision: "reject" });
}

async function requestChangesAction(context: PiActionsContext, id: string, request: Request) {
  const body = await parseObjectBody(request);
  return resolvePiActionDecision(context, {
    actionID: id,
    actor: cleanString(body.actor),
    comment: cleanString(body.comment || body.reason || body.requested_changes),
    decision: "request_changes"
  });
}

async function snoozeAction(context: PiActionsContext, id: string, request: Request) {
  const body = await parseObjectBody(request);
  return resolvePiActionDecision(context, {
    actionID: id,
    actor: cleanString(body.actor),
    decision: "snooze",
    reason: cleanString(body.reason),
    snoozedUntil: cleanString(body.until || body.snoozed_until)
  });
}

async function executeAction(context: PiActionsContext, id: string) {
  return await executeApprovedPiAction(context, id);
}

function actionID(request: Request): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const value = parts[parts.indexOf("actions") + 1]?.trim() ?? "";
  if (value === "") throw new HttpError(400, "PI action id 不能为空");
  return decodeURIComponent(value);
}

function piActionEventFilter(request: Request) {
  const params = new URL(request.url).searchParams;
  return {
    actionId: cleanParam(params.get("action_id")),
    conversationId: cleanParam(params.get("conversation_id")),
    delegationId: cleanParam(params.get("delegation_id")),
    eventType: cleanParam(params.get("event_type")),
    issueId: positiveID(params.get("issue_id")),
    projectId: cleanParam(params.get("project_id"))
  };
}

async function parseObjectBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await parseJsonBody(request);
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch (error) {
    if (error instanceof HttpError) return {};
    throw error;
  }
}

function piActionFilter(request: Request): PiActionFilter {
  const params = new URL(request.url).searchParams;
  return {
    conversationId: cleanParam(params.get("conversation_id")),
    issueId: positiveID(params.get("issue_id")),
    projectId: cleanParam(params.get("project_id")),
    status: cleanParam(params.get("status"))
  };
}

function positiveID(value: string | null): number | undefined {
  const text = cleanParam(value);
  if (text === "") return undefined;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function cleanParam(value: string | null): string {
  return value?.trim() ?? "";
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
