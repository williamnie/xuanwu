import type { RunnerDatabase } from "../db/database.ts";
import { readProjectPiPolicy, upsertProjectPiPolicy } from "../db/repositories/pi.ts";
import { getProject } from "../db/repositories/projects.ts";
import { normalizeMcpCapabilityList } from "../mcp/policy.ts";
import { normalizeSkillIntentList } from "../skills/intents.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

type PiProjectPolicyContext = { database: RunnerDatabase };
const SUPERVISOR_WAIT_POLICIES = new Set(["respect_retry_after", "default_cooldown", "ask"]);

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
  return writePolicyResponse(() => upsertProjectPiPolicy(context.database, {
    allowed_actions_json: body.allowed_actions,
    allowed_mcp_capabilities_json: body.allowed_mcp_capabilities,
    allowed_skill_intents_json: body.allowed_skill_intents,
    allowed_supervisor_actions_json: body.allowed_supervisor_actions,
    concurrency_policy_json: body.concurrency_policy,
    project_id: id,
    quiet_hours_json: body.quiet_hours,
    retry_policy_json: body.retry_policy,
    supervisor_cooldown_seconds: body.supervisor_cooldown_seconds,
    supervisor_max_recoveries_per_issue: body.supervisor_max_recoveries_per_issue,
    supervisor_max_recoveries_per_project_per_hour: body.supervisor_max_recoveries_per_project_per_hour,
    supervisor_rate_limit_wait_policy: body.supervisor_rate_limit_wait_policy,
    timezone: body.timezone,
    verification_policy_json: body.verification_policy,
    working_hours_json: body.working_hours
  }));
}

function normalizePolicyBody(body: Record<string, unknown>) {
  assertNoRemovedModeFields(body);
  return {
    allowed_actions: listField(body, ["allowed_actions_json", "allowed_actions", "allowedActions"], "allowed_actions"),
    allowed_mcp_capabilities: mcpField(body),
    allowed_skill_intents: skillField(body),
    allowed_supervisor_actions: listField(body, [
      "allowed_supervisor_actions_json", "allowed_supervisor_actions", "allowedSupervisorActions"
    ], "allowed_supervisor_actions"),
    concurrency_policy: objectField(body, ["concurrency_policy_json", "concurrency_policy"], "concurrency_policy"),
    quiet_hours: objectField(body, ["quiet_hours_json", "quiet_hours"], "quiet_hours"),
    retry_policy: objectField(body, ["retry_policy_json", "retry_policy"], "retry_policy"),
    supervisor_cooldown_seconds: positiveIntegerField(body, "supervisor_cooldown_seconds"),
    supervisor_max_recoveries_per_issue: positiveIntegerField(body, "supervisor_max_recoveries_per_issue"),
    supervisor_max_recoveries_per_project_per_hour: positiveIntegerField(body, "supervisor_max_recoveries_per_project_per_hour"),
    supervisor_rate_limit_wait_policy: supervisorWaitPolicy(body),
    timezone: stringField(body, "timezone"),
    verification_policy: objectField(body, ["verification_policy_json", "verification_policy"], "verification_policy"),
    working_hours: objectField(body, ["working_hours_json", "working_hours"], "working_hours")
  };
}

function assertNoRemovedModeFields(body: Record<string, unknown>): void {
  const field = ["default_mode", "supervisor_mode"].find((key) => Object.hasOwn(body, key));
  if (field) throw new HttpError(400, `${field} 已移除；PI 绑定项目后固定为 autonomous`);
}

function writePolicyResponse(write: () => unknown): Response {
  try {
    return json(write());
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error) throw new HttpError(400, error.message);
    throw error;
  }
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

function skillField(body: Record<string, unknown>): string | undefined {
  const value = rawField(body, ["allowed_skill_intents_json", "allowed_skill_intents", "allowedSkillIntents"]);
  return value === undefined ? undefined : checkedList(() => normalizeSkillIntentList(value));
}

function mcpField(body: Record<string, unknown>): string | undefined {
  const value = rawField(body, [
    "allowed_mcp_capabilities_json", "allowed_mcp_capabilities", "allowedMcpCapabilities"
  ]);
  return value === undefined ? undefined : checkedList(() => normalizeMcpCapabilityList(value));
}

function listField(body: Record<string, unknown>, keys: string[], label: string): string | undefined {
  const value = rawField(body, keys);
  return value === undefined ? undefined : JSON.stringify(actionList(value, label));
}

function checkedList(normalize: () => string): string {
  try {
    return normalize();
  } catch (error) {
    if (error instanceof Error) throw new HttpError(400, error.message);
    throw error;
  }
}

function rawField(body: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) if (Object.hasOwn(body, key)) return body[key];
  return undefined;
}

function actionList(value: unknown, label: string): string[] {
  return cleanActionList(parseList(value), label);
}

function parseList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  const text = stringValue(value);
  if (text === "") return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {}
  return text.split(/[\n,]/);
}

function cleanActionList(values: string[], label: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const id = stringValue(value).toLowerCase();
    if (id === "") continue;
    if (id.length > 128 || !/^[a-z0-9_.:-]+$/.test(id)) throw new HttpError(400, `${label} id 不合法: ${id}`);
    if (!seen.has(id)) out.push(id);
    seen.add(id);
  }
  return out;
}

function supervisorWaitPolicy(body: Record<string, unknown>): string | undefined {
  if (!Object.hasOwn(body, "supervisor_rate_limit_wait_policy")) return undefined;
  const mode = stringValue(body.supervisor_rate_limit_wait_policy);
  if (SUPERVISOR_WAIT_POLICIES.has(mode)) return mode;
  throw new HttpError(400, "supervisor_rate_limit_wait_policy 不合法");
}

function positiveIntegerField(body: Record<string, unknown>, key: string): number | undefined {
  if (!Object.hasOwn(body, key)) return undefined;
  const value = body[key];
  const number = typeof value === "number" ? value : Number(stringValue(value));
  if (Number.isInteger(number) && number > 0) return number;
  throw new HttpError(400, `${key} 必须是正整数`);
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  return Object.hasOwn(body, key) ? stringValue(body[key]) : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
