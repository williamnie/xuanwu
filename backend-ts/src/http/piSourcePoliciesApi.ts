import type { RunnerDatabase } from "../db/database.ts";
import { getProjectPiSettings, readProjectPiPolicy } from "../db/repositories/pi.ts";
import {
  createPiAutomation,
  listPiAutomations,
  updatePiAutomation,
  type PiAutomationRecord
} from "../db/repositories/piAutomations.ts";
import { getProject } from "../db/repositories/projects.ts";
import {
  resolveSourcePolicy,
  SOURCE_PROFILES,
  type EventRouterSourcePolicy,
  type SourceProfile
} from "../pi/eventRouter.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

type JsonObject = Record<string, unknown>;
type PiSourcePolicyContext = { database: RunnerDatabase };

const LAYERS = [
  { scope: "source_profile", owner: "eventRouter profile defaults", writable: false },
  { scope: "project", owner: "project_pi_settings / project_pi_policies", writable: false },
  { scope: "global", owner: "runtime safety defaults", writable: false },
  { scope: "automation", owner: "pi_automations.source_policy_json", writable: true }
];

export function registerPiSourcePolicyRoutes(router: Router, context: PiSourcePolicyContext): void {
  router.get("/api/pi/source-policies", (request) => json(listResponse(context, request)));
  router.post("/api/pi/source-policies", (request) => createResponse(context, request));
  router.patch("/api/pi/source-policies/automations/:id", (request) => patchAutomationResponse(context, request));
}

function listResponse(context: PiSourcePolicyContext, request: Request): JsonObject {
  const projectID = clean(new URL(request.url).searchParams.get("project_id"));
  return {
    automations: listPiAutomations(context.database).map(automationPolicy),
    global_policy: resolveSourcePolicy({ profile: "custom" }),
    layers: LAYERS,
    profiles: SOURCE_PROFILES.map(profilePolicy),
    project_policy: projectID === "" ? null : projectPolicy(context.database, projectID)
  };
}

async function createResponse(context: PiSourcePolicyContext, request: Request): Promise<Response> {
  const body = await objectBody(request);
  return writeResponse(() => ({
    automation: automationPolicy(createPolicyAutomation(context.database, body))
  }), 201);
}

async function patchAutomationResponse(context: PiSourcePolicyContext, request: Request): Promise<Response> {
  const body = await objectBody(request);
  return writeResponse(() => ({
    automation: automationPolicy(updatePiAutomation(context.database, pathID(request), {
      source_policy: sourcePolicyInput(body.source_policy ?? body)
    }))
  }));
}

function createPolicyAutomation(db: RunnerDatabase, body: JsonObject): PiAutomationRecord {
  const policy = sourcePolicyInput(body.source_policy ?? body);
  return createPiAutomation(db, {
    enabled: false,
    filters: sourceFilter(body.source),
    mode: "propose",
    name: clean(body.name) || `Source policy · ${clean(policy.profile) || "custom"}`,
    source_policy: policy,
    steps: [{ cursor: "", idempotency_key: "policy-only-source-sync", type: "source_sync", watermark: "" }],
    trigger: { type: "manual" }
  });
}

function profilePolicy(profile: SourceProfile): JsonObject {
  return { id: profile, policy: resolveSourcePolicy({ profile }) };
}

function automationPolicy(automation: PiAutomationRecord): JsonObject {
  return {
    effective_policy: resolveSourcePolicy(automation.source_policy as EventRouterSourcePolicy),
    enabled: automation.enabled,
    id: automation.id,
    mode: automation.mode,
    name: automation.name,
    source_policy: automation.source_policy,
    trigger_type: automation.trigger_type,
    updated_at: automation.updated_at
  };
}

function projectPolicy(db: RunnerDatabase, projectID: string): JsonObject {
  if (!getProject(db, projectID)) throw new HttpError(404, "project 不存在");
  const settings = getProjectPiSettings(db, projectID);
  const policy = readProjectPiPolicy(db, projectID);
  return {
    default_mode: policy.default_mode,
    issue_policy: {
      auto_create_triage_issue: settings?.auto_triage === 1,
      auto_enqueue: settings?.auto_enqueue === 1
    },
    project_id: projectID
  };
}

function sourcePolicyInput(value: unknown): JsonObject {
  const policy = resolveSourcePolicy(objectValue(value) as EventRouterSourcePolicy);
  return {
    action_mode: policy.action_mode,
    collect_raw_events: policy.collect_raw_events,
    intake_mode: policy.intake_mode,
    issue_policy: issuePolicy(policy.issue_policy),
    profile: policy.profile,
    reply_policy: replyPolicy(policy.reply_policy)
  };
}

function issuePolicy(value: unknown): JsonObject {
  const input = objectValue(value);
  return {
    auto_create_triage_issue: input.auto_create_triage_issue === true,
    auto_enqueue: input.auto_enqueue === true,
    require_project_confirmation: input.require_project_confirmation === true
  };
}

function replyPolicy(value: unknown): JsonObject {
  const input = objectValue(value);
  return {
    allowed_chats: stringList(input.allowed_chats),
    allowed_people: stringList(input.allowed_people),
    auto_reply_enabled: input.auto_reply_enabled === true,
    require_approval_for_external_reply: input.require_approval_for_external_reply !== false
  };
}

function sourceFilter(value: unknown): JsonObject[] {
  const source = clean(value);
  return source === "" ? [] : [{ source }];
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
  return objectValue(body);
}

function pathID(request: Request): number {
  const value = new URL(request.url).pathname.split("/").filter(Boolean).at(-1);
  const id = Number(clean(value));
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "automation id 不合法");
  return id;
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(clean).filter(Boolean))] : [];
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
