import type { RunnerDatabase } from "../db/database.ts";
import { readProjectPiPolicy, upsertProjectPiPolicy } from "../db/repositories/pi.ts";
import { getProject } from "../db/repositories/projects.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

type PiProjectPolicyContext = { database: RunnerDatabase };
const MODES = new Set(["manual", "attended", "delegated", "autonomous"]);

export function registerPiProjectPolicyRoutes(router: Router, context: PiProjectPolicyContext): void {
  router.get("/api/projects/:id/pi-policy", (request) => policyResponse(context, request));
  router.patch("/api/projects/:id/pi-policy", async (request) => patchPolicyResponse(context, request));
}

function policyResponse(context: PiProjectPolicyContext, request: Request): Response {
  const id = projectID(request);
  assertProjectExists(context.database, id);
  return json(readProjectPiPolicy(context.database, id));
}

async function patchPolicyResponse(context: PiProjectPolicyContext, request: Request): Promise<Response> {
  const id = projectID(request);
  assertProjectExists(context.database, id);
  const body = normalizePolicyBody(await parseObjectBody(request));
  return json(upsertProjectPiPolicy(context.database, {
    concurrency_policy_json: body.concurrency_policy,
    default_mode: body.default_mode,
    project_id: id,
    quiet_hours_json: body.quiet_hours,
    retry_policy_json: body.retry_policy,
    timezone: body.timezone,
    working_hours_json: body.working_hours
  }));
}

function normalizePolicyBody(body: Record<string, unknown>) {
  return {
    concurrency_policy: objectField(body, ["concurrency_policy_json", "concurrency_policy"], "concurrency_policy"),
    default_mode: policyMode(body),
    quiet_hours: objectField(body, ["quiet_hours_json", "quiet_hours"], "quiet_hours"),
    retry_policy: objectField(body, ["retry_policy_json", "retry_policy"], "retry_policy"),
    timezone: stringField(body, "timezone"),
    working_hours: objectField(body, ["working_hours_json", "working_hours"], "working_hours")
  };
}

async function parseObjectBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await parseJsonBody(request);
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch (error) {
    if (error instanceof HttpError) throw new HttpError(400, "请求体不是合法 JSON");
    throw error;
  }
}

function assertProjectExists(db: RunnerDatabase, id: string): void {
  if (!getProject(db, id)) throw new HttpError(404, "资源不存在");
}

function projectID(request: Request): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const value = parts[parts.indexOf("projects") + 1]?.trim() ?? "";
  if (value === "") throw new HttpError(400, "project id 不能为空");
  return decodeURIComponent(value);
}

function objectField(body: Record<string, unknown>, keys: string[], label: string): unknown {
  for (const key of keys) {
    if (Object.hasOwn(body, key)) return objectValue(body[key], label);
  }
  return undefined;
}

function objectValue(value: unknown, label: string): unknown {
  if (value === undefined || value === null) return undefined;
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  const text = stringValue(value);
  if (text === "") return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}
  throw new HttpError(400, `${label} 必须是合法 JSON object`);
}

function policyMode(body: Record<string, unknown>): string | undefined {
  if (!Object.hasOwn(body, "default_mode")) return undefined;
  const mode = stringValue(body.default_mode);
  if (MODES.has(mode)) return mode;
  throw new HttpError(400, "default_mode 不合法");
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  return Object.hasOwn(body, key) ? stringValue(body[key]) : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
