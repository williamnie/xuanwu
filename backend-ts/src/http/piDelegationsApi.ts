import type { RunnerDatabase } from "../db/database.ts";
import {
  createPiDelegation,
  getPiDelegation,
  listPiDelegations,
  updatePiDelegation
} from "../db/repositories/pi.ts";
import { getProject } from "../db/repositories/projects.ts";
import type { EventBus } from "../events/bus.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

type PiDelegationsContext = { bus?: EventBus; database: RunnerDatabase };

export function registerPiDelegationRoutes(router: Router, context: PiDelegationsContext): void {
  router.get("/api/pi/delegations", (request) => json(listPiDelegations(context.database, delegationFilter(request))));
  router.get("/api/pi/delegations/:id", (request) => json(requireDelegation(context.database, delegationID(request))));
  router.post("/api/pi/delegations", async (request) => createDelegationResponse(context, request));
  router.post("/api/pi/delegations/:id/pause", (request) => statusResponse(context, request, "paused"));
  router.post("/api/pi/delegations/:id/resume", (request) => statusResponse(context, request, "active"));
}

async function createDelegationResponse(context: PiDelegationsContext, request: Request): Promise<Response> {
  const body = await objectBody(request);
  const projectID = cleanString(body.project_id);
  if (!getProject(context.database, projectID)) throw new HttpError(404, "资源不存在");
  const delegation = createPiDelegation(context.database, {
    authorization_json: jsonInput(body.authorization_json ?? body.authorization, "{}"),
    intent_json: jsonInput(body.intent_json ?? body.intent, "{}"),
    next_heartbeat_at: cleanString(body.next_heartbeat_at),
    project_id: projectID,
    status: cleanString(body.status) || "active",
    title: cleanString(body.title) || "PI delegation"
  });
  publish(context.bus, "pi.delegation_created", delegation);
  return json(delegation, { status: 201 });
}

function statusResponse(context: PiDelegationsContext, request: Request, status: "active" | "paused"): Response {
  const current = requireDelegation(context.database, delegationID(request));
  const next = updatePiDelegation(context.database, current.id, { status });
  publish(context.bus, `pi.delegation_${status === "active" ? "resumed" : "paused"}`, next);
  return json(next);
}

function delegationFilter(request: Request) {
  const params = new URL(request.url).searchParams;
  return {
    projectId: cleanString(params.get("project_id")),
    status: cleanString(params.get("status"))
  };
}

function requireDelegation(db: RunnerDatabase, id: string) {
  const delegation = getPiDelegation(db, id);
  if (!delegation) throw new HttpError(404, "资源不存在");
  return delegation;
}

async function objectBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await parseJsonBody(request);
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch (error) {
    if (error instanceof HttpError) throw new HttpError(400, "请求体不是合法 JSON");
    throw error;
  }
}

function delegationID(request: Request): string {
  const value = pathPart(request, "delegations");
  if (value === "") throw new HttpError(400, "PI delegation id 不能为空");
  return value;
}

function pathPart(request: Request, marker: string): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  return decodeURIComponent(parts[parts.indexOf(marker) + 1]?.trim() ?? "");
}

function jsonInput(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  try {
    return value === undefined || value === null ? fallback : JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function publish(bus: EventBus | undefined, type: string, delegation: unknown): void {
  bus?.publish({ payload: JSON.stringify({ delegation }), type });
}
