import type { RunnerDatabase } from "../db/database.ts";
import {
  createPiDelegation,
  expirePiDelegation,
  getPiDelegation,
  listPiDelegations,
  pausePiDelegation,
  resumePiDelegation,
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
  router.patch("/api/pi/delegations/:id", async (request) => patchDelegationResponse(context, request));
  router.post("/api/pi/delegations/:id/expire", (request) => lifecycleResponse(context, request, expirePiDelegation, "pi.delegation_expired"));
  router.post("/api/pi/delegations/:id/pause", (request) => statusResponse(context, request, "paused"));
  router.post("/api/pi/delegations/:id/resume", (request) => statusResponse(context, request, "active"));
}

async function createDelegationResponse(context: PiDelegationsContext, request: Request): Promise<Response> {
  const body = await parseDelegationBody(request);
  const projectID = requireProjectID(body.project_id);
  assertProjectExists(context.database, projectID);
  const delegation = writeDelegation(() => createPiDelegation(context.database, {
    ...delegationJsonFields(body),
    next_heartbeat_at: cleanString(body.next_heartbeat_at),
    project_id: projectID,
    status: cleanString(body.status) || "active",
    title: cleanString(body.title) || "PI delegation"
  }));
  publish(context.bus, "pi.delegation_created", delegation);
  return json(delegation, { status: 201 });
}

async function patchDelegationResponse(context: PiDelegationsContext, request: Request): Promise<Response> {
  const id = delegationID(request);
  requireDelegation(context.database, id);
  const body = await parseDelegationBody(request);
  const patch = delegationPatch(body);
  const delegation = writeDelegation(() => updatePiDelegation(context.database, id, patch));
  publish(context.bus, "pi.delegation_updated", delegation);
  return json(delegation);
}

function statusResponse(context: PiDelegationsContext, request: Request, status: "active" | "paused"): Response {
  const event = `pi.delegation_${status === "active" ? "resumed" : "paused"}`;
  const write = status === "active" ? resumePiDelegation : pausePiDelegation;
  return lifecycleResponse(context, request, write, event);
}

function lifecycleResponse(
  context: PiDelegationsContext,
  request: Request,
  write: typeof pausePiDelegation,
  eventType: string
): Response {
  const current = requireDelegation(context.database, delegationID(request));
  const next = writeDelegation(() => write(context.database, current.id));
  publish(context.bus, eventType, next);
  return json(next);
}

function delegationPatch(body: Record<string, unknown>) {
  const patch: Record<string, unknown> = delegationJsonFields(body);
  setStringPatch(patch, "audit_source", body, ["audit_source"]);
  setStringPatch(patch, "expires_at", body, ["expires_at", "expiresAt"]);
  setStringPatch(patch, "last_heartbeat_at", body, ["last_heartbeat_at"]);
  setStringPatch(patch, "next_heartbeat_at", body, ["next_heartbeat_at"]);
  setStringPatch(patch, "starts_at", body, ["starts_at", "startsAt"]);
  setStringPatch(patch, "status", body, ["status"]);
  setStringPatch(patch, "title", body, ["title"]);
  return patch;
}

function delegationJsonFields(body: Record<string, unknown>) {
  return {
    allowed_actions_json: jsonFieldInput(body, ["allowed_actions_json", "allowed_actions", "allowedActions"], "[]", "allowed_actions"),
    authorization_json: jsonFieldInput(body, ["authorization_json", "authorization"], "{}", "authorization"),
    forbidden_actions_json: jsonFieldInput(body, ["forbidden_actions_json", "forbidden_actions", "forbiddenActions"], "[]", "forbidden_actions"),
    intent_json: jsonFieldInput(body, ["intent_json", "intent"], "{}", "intent"),
    scope_json: jsonFieldInput(body, ["scope_json", "scope", "scopes"], "{}", "scope")
  };
}

function writeDelegation(write: () => ReturnType<typeof createPiDelegation>) {
  try {
    return write();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error) throw new HttpError(400, error.message);
    throw error;
  }
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

async function parseDelegationBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await parseJsonBody(request);
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch (error) {
    if (error instanceof HttpError) throw new HttpError(400, "请求体不是合法 JSON");
    throw error;
  }
}

function assertProjectExists(db: RunnerDatabase, projectID: string): void {
  if (!getProject(db, projectID)) throw new HttpError(404, "资源不存在");
}

function requireProjectID(value: unknown): string {
  const projectID = cleanString(value);
  if (projectID === "") throw new HttpError(400, "project_id 不能为空");
  return projectID;
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

function jsonFieldInput(body: Record<string, unknown>, keys: string[], fallback: string, label: string): string | undefined {
  for (const key of keys) {
    if (Object.hasOwn(body, key)) return jsonInput(body[key], fallback, label);
  }
  return undefined;
}

function setStringPatch(
  patch: Record<string, unknown>,
  field: string,
  body: Record<string, unknown>,
  keys: string[]
): void {
  for (const key of keys) {
    if (!Object.hasOwn(body, key)) continue;
    patch[field] = cleanString(body[key]);
    return;
  }
}

function jsonInput(value: unknown, fallback: string, label: string): string {
  if (value === undefined || value === null) return fallback;
  const text = cleanString(value);
  if (typeof value === "string") {
    if (text === "") return fallback;
    validateJson(text, label);
    return text;
  }
  try {
    return JSON.stringify(value);
  } catch {
    throw new HttpError(400, `${label} 必须是合法 JSON`);
  }
}

function validateJson(text: string, label: string): void {
  try {
    JSON.parse(text);
  } catch {
    throw new HttpError(400, `${label} 必须是合法 JSON`);
  }
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function publish(bus: EventBus | undefined, type: string, delegation: unknown): void {
  bus?.publish({ payload: JSON.stringify({ delegation }), type });
}
