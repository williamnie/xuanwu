import {
  diagnosePiHeartbeat,
  pausePiHeartbeat,
  resumePiHeartbeat
} from "../db/repositories/pi.ts";
import { getProject } from "../db/repositories/projects.ts";
import { runPiHeartbeatOnce } from "../pi/heartbeatOrchestrator.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

type PiHeartbeatApiContext = { database: RunnerDatabase };
type HeartbeatControlAction = "pause" | "resume";

export function registerPiHeartbeatRoutes(router: Router, context: PiHeartbeatApiContext): void {
  router.post("/api/projects/:id/pi/heartbeat/run-once", (request) => runOnceResponse(context, request));
  router.post("/api/projects/:id/pi/heartbeat/pause", (request) => controlResponse(context, request, "pause"));
  router.post("/api/projects/:id/pi/heartbeat/resume", (request) => controlResponse(context, request, "resume"));
  router.get("/api/projects/:id/pi/heartbeat/diagnostics", (request) => diagnosticsResponse(context, request));
}

async function runOnceResponse(context: PiHeartbeatApiContext, request: Request): Promise<Response> {
  const projectID = requireProjectID(context.database, request);
  return writeResponse(async () => runPiHeartbeatOnce({
    database: context.database,
    kind: "project",
    projectID,
    trigger: "api"
  }), 201);
}

async function controlResponse(
  context: PiHeartbeatApiContext,
  request: Request,
  action: HeartbeatControlAction
): Promise<Response> {
  const projectID = requireProjectID(context.database, request);
  const body = await objectBody(request);
  return writeResponse(() => {
    const input = { reason: cleanString(body.reason), scopeId: projectID, scopeType: "project" };
    return action === "pause" ? pausePiHeartbeat(context.database, input) : resumePiHeartbeat(context.database, input);
  });
}

function diagnosticsResponse(context: PiHeartbeatApiContext, request: Request): Response {
  const projectID = requireProjectID(context.database, request);
  return json(diagnosePiHeartbeat(context.database, { scopeId: projectID, scopeType: "project" }));
}

function requireProjectID(db: RunnerDatabase, request: Request): string {
  const id = pathPart(request, "projects");
  if (!getProject(db, id)) throw new HttpError(404, "资源不存在");
  return id;
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

async function writeResponse(write: () => unknown | Promise<unknown>, status = 200): Promise<Response> {
  try {
    return json(await write(), { status });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error) throw new HttpError(400, error.message);
    throw error;
  }
}

function pathPart(request: Request, marker: string): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const value = parts[parts.indexOf(marker) + 1]?.trim() ?? "";
  if (value === "") throw new HttpError(400, `${marker} id 不能为空`);
  return decodeURIComponent(value);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
