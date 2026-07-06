import type { RunnerDatabase } from "../db/database.ts";
import {
  createPiAutomation,
  getPiAutomation,
  listPiAutomations,
  listRunnablePiAutomations,
  updatePiAutomation,
  type AutomationTriggerType,
  type PiAutomationFilter,
  type PiAutomationInput
} from "../db/repositories/piAutomations.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

type PiAutomationContext = { database: RunnerDatabase };
type JsonObject = Record<string, unknown>;

export function registerPiAutomationRoutes(router: Router, context: PiAutomationContext): void {
  router.get("/api/pi/automations", (request) => json({ automations: listPiAutomations(context.database, filter(request)) }));
  router.get("/api/pi/automations/runnable", (request) => runnableResponse(context, request));
  router.post("/api/pi/automations", (request) => createResponse(context, request));
  router.get("/api/pi/automations/:id", (request) => detailResponse(context, request));
  router.patch("/api/pi/automations/:id", (request) => patchResponse(context, request));
}

function runnableResponse(context: PiAutomationContext, request: Request): Response {
  const trigger = triggerParam(new URL(request.url).searchParams);
  return json({ automations: listRunnablePiAutomations(context.database, trigger) });
}

async function createResponse(context: PiAutomationContext, request: Request): Promise<Response> {
  const body = await objectBody(request);
  return writeResponse(() => ({ automation: createPiAutomation(context.database, body as PiAutomationInput) }), 201);
}

function detailResponse(context: PiAutomationContext, request: Request): Response {
  const automation = getPiAutomation(context.database, pathID(request));
  if (!automation) throw new HttpError(404, "automation 不存在");
  return json({ automation });
}

async function patchResponse(context: PiAutomationContext, request: Request): Promise<Response> {
  const body = await objectBody(request);
  return writeResponse(() => ({ automation: updatePiAutomation(context.database, pathID(request), body) }));
}

async function writeResponse(write: () => unknown, status = 200): Promise<Response> {
  try {
    return json(write(), { status });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error) throw new HttpError(400, error.message);
    throw error;
  }
}

async function objectBody(request: Request): Promise<JsonObject> {
  const body = await parseJsonBody(request);
  return body && typeof body === "object" && !Array.isArray(body) ? body as JsonObject : {};
}

function filter(request: Request): PiAutomationFilter {
  const params = new URL(request.url).searchParams;
  return { enabled: enabledParam(params), triggerType: triggerParam(params) };
}

function triggerParam(params: URLSearchParams): AutomationTriggerType | undefined {
  const value = clean(params.get("trigger_type") || params.get("triggerType"));
  if (value === "") return undefined;
  if (value === "manual" || value === "schedule" || value === "continuous" || value === "webhook") return value;
  throw new HttpError(400, "trigger_type 不合法");
}

function enabledParam(params: URLSearchParams): boolean | undefined {
  const value = clean(params.get("enabled"));
  if (value === "") return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new HttpError(400, "enabled 不合法");
}

function pathID(request: Request): number {
  const value = new URL(request.url).pathname.split("/").filter(Boolean).at(-1);
  const id = Number(clean(value));
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "automation id 不合法");
  return id;
}

function clean(value: string | null | undefined): string {
  return value?.trim() ?? "";
}
