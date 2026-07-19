import type { RunnerDatabase } from "../db/database.ts";
import {
  createAutomation,
  getAutomation,
  getAutomationTrigger,
  listAutomationEvents,
  listAutomationRuns,
  listAutomations,
  reviseAutomationTrigger,
  transitionAutomationStatus,
  updateAutomationDefinition,
  type AutomationDefinitionPatch,
  type AutomationListFilter
} from "../db/repositories/automations.ts";
import { enqueueAutomationRunNow, nextCronOccurrence } from "../db/repositories/automationScheduler.ts";
import type {
  AutomationAudit,
  AutomationDefinition,
  AutomationID,
  AutomationMode,
  AutomationStatus,
  AutomationTriggerConfig
} from "../domain/automation/contracts.ts";
import type { EventBus } from "../events/bus.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

type AutomationApiContext = { bus?: EventBus; database: RunnerDatabase };
type JsonObject = Record<string, unknown>;

export const AUTOMATION_API_AUTHORITY = {
  definition: "automation_definitions",
  dual_read: "none",
  dual_write: "none",
  events: "automation_events+automation_run_events",
  runs: "automation_runs",
  compatibility: "legacy Cron, PI Automation, delegation, and completion-watch routes permanently redirect here without legacy reads or writes",
  rollback: "stop the target scheduler, restore the retained pre-cutover SQLite backup, and deploy the previous release; never enable both writers",
  final_delete_gate: "P11/G7 only after two releases with zero legacy producer/consumer, restart and retry parity, backup/restore evidence, and non-LLM destructive approval"
} as const;

export function registerAutomationRoutes(router: Router, context: AutomationApiContext): void {
  router.get("/api/automations", (request) => listResponse(context.database, request));
  router.post("/api/automations", (request) => createResponse(context, request));
  router.get("/api/automations/:id", (request) => detailResponse(context.database, request));
  router.patch("/api/automations/:id", (request) => updateResponse(context, request));
  router.patch("/api/automations/:id/trigger", (request) => triggerResponse(context, request));
  router.post("/api/automations/:id/status", (request) => statusResponse(context, request));
  router.post("/api/automations/:id/run-now", (request) => runNowResponse(context, request));
}

function listResponse(db: RunnerDatabase, request: Request): Response {
  const filter = automationFilter(new URL(request.url).searchParams);
  return json({ authority: AUTOMATION_API_AUTHORITY, automations: listAutomations(db, filter).map((item) => listItem(db, item)) });
}

function detailResponse(db: RunnerDatabase, request: Request): Response {
  const id = automationID(request);
  const automation = getAutomation(db, id);
  if (!automation) throw new HttpError(404, "automation 不存在");
  return json({
    authority: AUTOMATION_API_AUTHORITY,
    automation,
    events: listAutomationEvents(db, id),
    runs: listAutomationRuns(db, id),
    trigger: getAutomationTrigger(db, id)
  });
}

async function createResponse(context: AutomationApiContext, request: Request): Promise<Response> {
  const body = await objectBody(request);
  const now = new Date();
  const id = createID(body.id);
  const trigger = triggerInput(body.trigger);
  const audit = userAudit(id, "create", now);
  const nextRunAt = optionalText(body.next_run_at) || initialNextRun(trigger, now);
  const owner = ownerInput(body.owner, body.project_id);
  return writeResponse(() => {
    const automation = createAutomation(context.database, {
      id,
      idempotency_namespace: optionalText(body.idempotency_namespace) || id,
      mode: automationMode(body.mode),
      name: requiredText(body.name, "name"),
      next_run_at: nextRunAt,
      owner,
      permission_policy_ref: optionalText(body.permission_policy_ref) || ownerPolicy(owner),
      status: automationStatus(body.status, "active"),
      trigger,
      trigger_created_by: audit.actor_id,
      workflow_ref: requiredText(body.workflow_ref, "workflow_ref")
    }, now.toISOString(), audit);
    publish(context, "automation.created", automation);
    return { authority: AUTOMATION_API_AUTHORITY, automation };
  }, 201);
}

async function updateResponse(context: AutomationApiContext, request: Request): Promise<Response> {
  const body = await objectBody(request);
  const id = automationID(request);
  const expectedRevision = revision(body.expected_revision);
  const patch = definitionPatch(body);
  return writeResponse(() => {
    const automation = updateAutomationDefinition(context.database, id, patch, expectedRevision, userAudit(id, "update"));
    publish(context, "automation.updated", automation);
    return { authority: AUTOMATION_API_AUTHORITY, automation };
  });
}

async function triggerResponse(context: AutomationApiContext, request: Request): Promise<Response> {
  const body = await objectBody(request);
  const id = automationID(request);
  const expectedRevision = revision(body.expected_revision);
  const current = getAutomation(context.database, id);
  if (!current) throw new HttpError(404, "automation 不存在");
  if (current.revision !== expectedRevision) throw new HttpError(409, "automation revision conflict");
  const trigger = triggerInput(body.trigger);
  const now = new Date();
  const nextRunAt = optionalText(body.next_run_at) || initialNextRun(trigger, now);
  return writeResponse(() => {
    const automation = reviseAutomationTrigger(context.database, id, trigger, userAudit(id, "trigger", now), nextRunAt, expectedRevision);
    publish(context, "automation.updated", automation);
    return { authority: AUTOMATION_API_AUTHORITY, automation, trigger: getAutomationTrigger(context.database, id) };
  });
}

async function statusResponse(context: AutomationApiContext, request: Request): Promise<Response> {
  const body = await objectBody(request);
  const id = automationID(request);
  const status = automationStatus(body.status);
  return writeResponse(() => {
    const automation = transitionAutomationStatus(context.database, id, {
      audit: userAudit(id, `status:${status}`), expected_revision: revision(body.expected_revision), status
    });
    publish(context, "automation.status_changed", automation);
    return { authority: AUTOMATION_API_AUTHORITY, automation };
  });
}

async function runNowResponse(context: AutomationApiContext, request: Request): Promise<Response> {
  const body = await objectBody(request);
  const id = automationID(request);
  return writeResponse(() => {
    const run = enqueueAutomationRunNow(
      context.database, id, revision(body.expected_revision), userAudit(id, "run-now")
    );
    const automation = getAutomation(context.database, id)!;
    publish(context, "automation.run_queued", automation, run.run_id);
    return { authority: AUTOMATION_API_AUTHORITY, run };
  }, 202);
}

function listItem(db: RunnerDatabase, automation: AutomationDefinition) {
  return { ...automation, latest_run: listAutomationRuns(db, automation.id)[0] ?? null, trigger: getAutomationTrigger(db, automation.id) };
}

function automationFilter(params: URLSearchParams): AutomationListFilter {
  const projectID = optionalText(params.get("project_id"));
  const statusText = optionalText(params.get("status"));
  const triggerText = optionalText(params.get("trigger_type"));
  return {
    ...(projectID ? { project_id: projectID } : {}),
    ...(statusText ? { status: automationStatus(statusText) } : {}),
    ...(triggerText ? { trigger_type: triggerType(triggerText) } : {})
  };
}

function definitionPatch(body: JsonObject): AutomationDefinitionPatch {
  const patch: AutomationDefinitionPatch = {};
  if (body.name !== undefined) patch.name = requiredText(body.name, "name");
  if (body.workflow_ref !== undefined) patch.workflow_ref = requiredText(body.workflow_ref, "workflow_ref");
  if (body.permission_policy_ref !== undefined) patch.permission_policy_ref = requiredText(body.permission_policy_ref, "permission_policy_ref");
  if (body.mode !== undefined) patch.mode = automationMode(body.mode);
  if (body.next_run_at !== undefined) patch.next_run_at = optionalText(body.next_run_at) || null;
  if (Object.keys(patch).length === 0) throw new HttpError(400, "没有可更新的 automation 字段");
  return patch;
}

function triggerInput(value: unknown): AutomationTriggerConfig {
  const input = objectValue(value, "trigger");
  const type = triggerType(input.type);
  const config = objectValue(input.config ?? {}, "trigger.config");
  if (type === "cron") return { type, config: { expression: requiredText(config.expression, "cron expression"), timezone: requiredText(config.timezone, "cron timezone") } };
  if (type === "continuous") return { type, config: { poll_interval_seconds: positiveInteger(config.poll_interval_seconds, "poll_interval_seconds") } };
  if (type === "webhook") return { type, config: { event_type: requiredText(config.event_type, "event_type"), ...(optionalText(config.secret_ref) ? { secret_ref: optionalText(config.secret_ref) } : {}) } };
  const targetIssueID = Number(config.target_issue_id);
  return { type: "manual", config: Number.isSafeInteger(targetIssueID) && targetIssueID > 0 ? { target_issue_id: targetIssueID } : {} };
}

function initialNextRun(trigger: AutomationTriggerConfig, now: Date): string | null {
  if (trigger.type === "cron") return nextCronOccurrence(trigger.config.expression, trigger.config.timezone, now)?.toISOString() ?? null;
  if (trigger.type === "continuous") return new Date(now.getTime() + trigger.config.poll_interval_seconds * 1000).toISOString();
  return null;
}

function ownerInput(value: unknown, projectID: unknown): AutomationDefinition["owner"] {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
  const project = optionalText(input.project_id) || optionalText(projectID);
  return project ? { kind: "project", project_id: project } : { kind: "control_plane", control_plane_id: "local" };
}

function ownerPolicy(owner: AutomationDefinition["owner"]): string {
  return owner.kind === "project" ? `project-policy:${owner.project_id}` : "control-plane-policy:local";
}

function userAudit(id: AutomationID, operation: string, now = new Date()): AutomationAudit {
  const nonce = crypto.randomUUID();
  return {
    actor_id: "frontend:user",
    actor_kind: "user",
    correlation_id: `automation-ui:${id}:${nonce}`,
    event_id: `automation-event:${operation.replace(/[^a-zA-Z0-9._-]/g, "-")}:${nonce}`,
    gate: { authority: "human_approval", decision: "allow", policy_ref: "automation-ui:authenticated-user:v1" },
    occurred_at: now.toISOString(),
    reason: `Authenticated user requested Automation ${operation}`
  };
}

function publish(context: AutomationApiContext, type: string, automation: AutomationDefinition, runID = ""): void {
  context.bus?.publish({
    projectId: automation.owner.kind === "project" ? automation.owner.project_id : "",
    status: automation.status,
    type,
    payload: JSON.stringify({ automation_id: automation.id, revision: automation.revision, run_id: runID })
  });
}

function automationID(request: Request): AutomationID {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const raw = decodeURIComponent(parts[parts.indexOf("automations") + 1] || "");
  return createID(raw);
}

function createID(value: unknown): AutomationID {
  const text = requiredText(value, "automation id");
  const id = (text.startsWith("automation:") ? text : `automation:${text}`) as AutomationID;
  if (!/^automation:[a-z][a-z0-9._-]{0,127}$/.test(id)) throw new HttpError(400, "automation id 不合法");
  return id;
}

function automationStatus(value: unknown, fallback?: AutomationStatus): AutomationStatus {
  const text = optionalText(value) || fallback || "";
  if (["draft", "active", "paused", "archived"].includes(text)) return text as AutomationStatus;
  throw new HttpError(400, "automation status 不合法");
}

function automationMode(value: unknown): AutomationMode {
  const text = optionalText(value) || "propose";
  if (["observe", "propose", "execute_allowed"].includes(text)) return text as AutomationMode;
  throw new HttpError(400, "automation mode 不合法");
}

function triggerType(value: unknown): AutomationTriggerConfig["type"] {
  const text = optionalText(value);
  if (["cron", "manual", "webhook", "continuous"].includes(text)) return text as AutomationTriggerConfig["type"];
  throw new HttpError(400, "automation trigger_type 不合法");
}

function revision(value: unknown): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new HttpError(400, "expected_revision 必须是非负整数");
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new HttpError(400, `${label} 必须是正整数`);
  return result;
}

async function objectBody(request: Request): Promise<JsonObject> {
  return objectValue(await parseJsonBody(request), "request body");
}

function objectValue(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, `${label} 必须是对象`);
  return value as JsonObject;
}

function requiredText(value: unknown, label: string): string {
  const result = optionalText(value);
  if (!result) throw new HttpError(400, `${label} 不能为空`);
  return result;
}

function optionalText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function writeResponse(write: () => unknown, status = 200): Response {
  try {
    return json(write(), { status });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const message = error instanceof Error ? error.message : "Automation mutation failed";
    throw new HttpError(/not found|不存在/.test(message) ? 404 : /conflict|already exists|only active/.test(message) ? 409 : 400, message);
  }
}
