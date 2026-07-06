import type { RunnerConfig } from "../config/env.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { getContextBundle } from "../db/repositories/contextBundles.ts";
import {
  createIntakeRun,
  getAttentionInboxItem,
  listIntakeRuns,
  type IntakeRunStatus
} from "../db/repositories/intakeRuns.ts";
import { getPiAction, listPiActionEvents, type PiActionEvent } from "../db/repositories/pi.ts";
import { runDomainSkillAndMarkProposal } from "../pi/domainSkillRun.ts";
import { buildIntakeSkillInput } from "../pi/intakeSkillInput.ts";
import { loadAssistantToolRegistrySnapshot } from "../pi/toolRegistrySnapshot.ts";
import { readSkillRegistry, type SkillMetadata, type SkillRegistryDiagnostic } from "../skills/registry.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import { publicIntakeRun, redactedJsonObject, runDiagnostics } from "./piSkillRunViews.ts";
import type { Router } from "./router.ts";

type SkillRouteContext = { config?: RunnerConfig; database: RunnerDatabase };
type JsonObject = Record<string, unknown>;
type SkillRegistryView = { diagnostics: SkillRegistryDiagnostic[]; items: SkillMetadata[] };

const DOMAIN_EVENT_TYPE = "attention_inbox.domain_skill_requested";
const RUN_STATUSES = new Set(["running", "succeeded", "failed"]);

export function registerPiSkillRoutes(router: Router, context?: SkillRouteContext): void {
  router.get("/api/pi/skills", () => skillsResponse(context));
  router.get("/api/pi/skills/intake-runs", (request) => json(intakeRunsResponse(context, request)));
  router.get("/api/pi/skills/domain-runs", (request) => json(domainRunsResponse(context, request)));
  router.post("/api/pi/skills/:id/intake-runs", (request) => startIntakeRun(context, request));
  router.post("/api/pi/skills/:id/domain-runs", (request) => startDomainRun(context, request));
  router.get("/api/pi/skills/:id", (request) => skillResponse(request, context));
}

function skillsResponse(context?: SkillRouteContext): Response {
  const registry = readRegistry(context);
  return json({ diagnostics: registry.diagnostics, skills: decorateSkills(registry) });
}

function skillResponse(request: Request, context?: SkillRouteContext): Response {
  const id = skillID(request);
  const registry = readRegistry(context);
  const skill = findSkill(registry.items, id);
  if (!skill) throw new HttpError(404, `skill 不存在: ${id}`);
  return json({ diagnostics: registry.diagnostics, skill: decoratedSkill(skill, registry) });
}

function intakeRunsResponse(context: SkillRouteContext | undefined, request: Request): JsonObject[] {
  const db = requireDatabase(context);
  const params = new URL(request.url).searchParams;
  const skill = cleanParam(params.get("skill_id") || params.get("skillId"));
  const limit = queryLimit(params.get("limit"));
  return listIntakeRuns(db, {
    bundleId: queryID(params.get("bundle_id") || params.get("bundleId")),
    limit: 500,
    status: runStatus(params.get("status"))
  }).filter((run) => skill === "" || run.skill_id === skill)
    .slice(0, limit)
    .map(publicIntakeRun);
}

function domainRunsResponse(context: SkillRouteContext | undefined, request: Request): JsonObject[] {
  const db = requireDatabase(context);
  const params = new URL(request.url).searchParams;
  const skill = cleanParam(params.get("skill_id") || params.get("skillId"));
  const itemID = queryID(params.get("item_id") || params.get("itemId"));
  const status = cleanParam(params.get("status"));
  return listPiActionEvents(db, { eventType: DOMAIN_EVENT_TYPE })
    .map((event) => domainRunView(db, event))
    .filter((run) => skill === "" || run.skill_id === skill)
    .filter((run) => !itemID || run.item_id === itemID)
    .filter((run) => status === "" || run.status === status)
    .sort((left, right) => positiveNumber(right.id) - positiveNumber(left.id))
    .slice(0, queryLimit(params.get("limit")));
}

async function startIntakeRun(context: SkillRouteContext | undefined, request: Request): Promise<Response> {
  const db = requireDatabase(context);
  const skill = requireRuntimeSkill(request, context, "intake");
  const body = await objectBody(request);
  const bundle = getContextBundle(db, positiveBodyID(body, "bundle_id"));
  if (!bundle) throw new HttpError(404, "context bundle not found");
  const input = buildIntakeSkillInput(db, bundle);
  const run = createIntakeRun(db, {
    bundle_id: bundle.id,
    input_summary: input as unknown as JsonObject,
    skill_id: skill.id,
    status: "running"
  });
  return json({ created: true, run: publicIntakeRun(run) }, { status: 202 });
}

async function startDomainRun(context: SkillRouteContext | undefined, request: Request): Promise<Response> {
  const db = requireDatabase(context);
  const skill = requireRuntimeSkill(request, context, "domain");
  const body = await objectBody(request);
  const item = getAttentionInboxItem(db, positiveBodyID(body, "item_id"));
  if (!item) throw new HttpError(404, "attention inbox item not found");
  const result = runDomainSkillAndMarkProposal(db, item, skill.id);
  return json({ action: result.action, item: result.item, run: latestDomainRun(db, result.action.id) }, { status: 202 });
}

function latestDomainRun(db: RunnerDatabase, actionID: string): JsonObject | null {
  const event = listPiActionEvents(db, { actionId: actionID, eventType: DOMAIN_EVENT_TYPE }).at(-1);
  return event ? domainRunView(db, event) : null;
}

function domainRunView(db: RunnerDatabase, event: PiActionEvent): JsonObject {
  const eventPayload = redactedJsonObject(parseJson(event.payload_json));
  const action = getPiAction(db, event.action_id);
  const actionPayload = redactedJsonObject(parseJson(action?.payload_json));
  const itemID = positiveNumber(eventPayload.item_id || actionPayload.item_id);
  const item = itemID ? getAttentionInboxItem(db, itemID) : null;
  const error = event.error;
  return {
    id: event.id,
    kind: "domain",
    status: error ? "failed" : "succeeded",
    proposal_status: action?.status || "",
    skill_id: cleanString(actionPayload.skill_id || eventPayload.skill_id) || "fixture-domain",
    item_id: itemID,
    bundle_id: item?.bundle_id ?? 0,
    input_id: itemID,
    input_object: "inbox_item",
    primary_intent: cleanString(eventPayload.primary_intent || actionPayload.primary_intent || item?.primary_intent),
    action_count: positiveNumber(eventPayload.action_count),
    proposal_action_id: event.action_id,
    schema_output: actionPayload,
    error,
    diagnostics: runDiagnostics(error),
    links: {
      context_bundle: item ? `/api/pi/attention-inbox/context-bundles/${item.bundle_id}` : "",
      inbox_item: itemID ? `/api/pi/attention-inbox/items/${itemID}` : "",
      proposal: `/api/pi/actions/${encodeURIComponent(event.action_id)}`
    },
    created_at: event.created_at,
    updated_at: action?.updated_at || event.created_at
  };
}

function decorateSkills(registry: SkillRegistryView): JsonObject[] {
  return registry.items.map((skill) => decoratedSkill(skill, registry));
}

function decoratedSkill(skill: SkillMetadata, registry: SkillRegistryView): JsonObject {
  const diagnostics = skillDiagnostics(skill, registry.diagnostics);
  return {
    ...skill,
    diagnostics,
    enabled: skill.kind ? diagnostics.length === 0 : true,
    runtime_status: skill.kind ? (diagnostics.length === 0 ? "enabled" : "diagnostic") : "metadata_only"
  };
}

function skillDiagnostics(skill: SkillMetadata, diagnostics: SkillRegistryDiagnostic[]): SkillRegistryDiagnostic[] {
  const path = skill.runtime_manifest_path || skill.source_path;
  return diagnostics.filter((item) => item.source_path === path || item.source_path === skill.source_path);
}

function requireRuntimeSkill(
  request: Request,
  context: SkillRouteContext | undefined,
  kind: "domain" | "intake"
): SkillMetadata {
  const id = skillID(request);
  const registry = readRegistry(context);
  const skill = findSkill(registry.items, id);
  if (!skill) throw new HttpError(404, `skill 不存在: ${id}`);
  if (skill.kind !== kind) throw new HttpError(400, `skill kind 必须是 ${kind}`);
  const diagnostics = skillDiagnostics(skill, registry.diagnostics);
  if (diagnostics.length > 0) throw new HttpError(400, "skill 存在诊断，不能手动运行");
  return skill;
}

function readRegistry(context?: SkillRouteContext) {
  if (!context) return readSkillRegistry();
  const snapshot = loadAssistantToolRegistrySnapshot(context.database, {
    cliConnectorDirs: context.config?.cliConnectors.manifestDirs ?? []
  });
  const availableTools = snapshot.tools.map((tool) => ({
    name: tool.name,
    permission: tool.permission,
    provider_id: tool.provider_id
  }));
  return readSkillRegistry({ availableTools });
}

function findSkill(skills: SkillMetadata[], id: string): SkillMetadata | undefined {
  const wanted = normalizeID(id);
  return skills.find((skill) => skill.id === wanted || skill.name === wanted);
}

async function objectBody(request: Request): Promise<JsonObject> {
  const body = await parseJsonBody(request);
  return body && typeof body === "object" && !Array.isArray(body) ? body as JsonObject : {};
}

function positiveBodyID(body: JsonObject, field: "bundle_id" | "item_id"): number {
  const camel = field === "bundle_id" ? "bundleId" : "itemId";
  const id = positiveNumber(body[field] || body[camel]);
  if (!id) throw new HttpError(400, `${field} 必须是正整数`);
  return id;
}

function skillID(request: Request): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const value = parts[parts.indexOf("skills") + 1]?.trim() ?? "";
  if (value === "") throw new HttpError(400, "skill id 不能为空");
  return decodeURIComponent(value);
}

function runStatus(value: string | null): IntakeRunStatus | undefined {
  const status = cleanParam(value);
  if (status === "") return undefined;
  if (!RUN_STATUSES.has(status)) throw new HttpError(400, "run status 不合法");
  return status as IntakeRunStatus;
}

function queryID(value: string | null): number | undefined {
  const id = Number(cleanParam(value));
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function queryLimit(value: string | null): number {
  const limit = Number(cleanParam(value));
  return Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 50;
}

function parseJson(value: unknown): unknown {
  try { return JSON.parse(cleanString(value) || "{}"); } catch { return {}; }
}

function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function requireDatabase(context?: SkillRouteContext): RunnerDatabase {
  if (!context?.database) throw new HttpError(503, "database is required");
  return context.database;
}

function cleanParam(value: string | null): string {
  return value?.trim() ?? "";
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeID(value: unknown): string {
  return cleanString(value).toLowerCase().replace(/[^a-z0-9_:-]+/g, "-").replace(/^-+|-+$/g, "");
}
