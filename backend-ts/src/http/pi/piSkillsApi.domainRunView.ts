import type { RunnerDatabase } from "../../db/database.ts";
import { getContextBundle } from "../../db/repositories/contextBundles.ts";
import { createIntakeRun, getAttentionInboxItem } from "../../db/repositories/intakeRuns.ts";
import { getPiAction, type PiActionEvent } from "../../db/repositories/pi.ts";
import { runDomainSkillAndMarkProposal } from "../../pi/tools/domainSkillRun.ts";
import { buildIntakeSkillInput } from "../../pi/intake/intakeSkillInput.ts";
import { type SkillMetadata } from "../../skills/registry.ts";
import { DEFAULT_DOMAIN_SKILL_ID } from "../../skills/builtinDomainProposal.ts";
import { HttpError, json, parseJsonBody } from "../errors.ts";
import { publicIntakeRun, redactedJsonObject, runDiagnostics } from "./piSkillRunViews.ts";
import type { Router } from "../router.ts";
import { registerJevSkillSettingsRoutes } from "../settings/jevSkillSettingsApi.ts";
import { registerSkillLibraryRoutes } from "../settings/skillLibraryApi.ts";
import { visibleManagedSkills, validateManagedSkill } from "../../skills/managedStore.ts";
import { dirname } from "node:path";
import { cleanString, positiveInteger } from "../../util/values.ts";
import type { SkillRouteContext, JsonObject } from "./piSkillsApi.model.ts";
import { skillsResponse, intakeRunsResponse, readRegistry, jevSkillView, decoratedSkill, requireDatabase, cleanParam, queryID, domainRunEvents, queryLimit, parseJson, skillDiagnostics } from "./piSkillsApi.decoratedSkill.ts";

export function registerPiSkillRoutes(router: Router, context?: SkillRouteContext): void {
  if (context) registerSkillLibraryRoutes(router, context.database);
  if (context) registerJevSkillSettingsRoutes(router, context);
  router.get("/api/pi/skills", () => skillsResponse(context));
  router.get("/api/pi/skills/intake-runs", (request) => json(intakeRunsResponse(context, request)));
  router.get("/api/pi/skills/domain-runs", (request) => json(domainRunsResponse(context, request)));
  router.post("/api/pi/skills/:id/intake-runs", (request) => startIntakeRun(context, request));
  router.post("/api/pi/skills/:id/domain-runs", (request) => startDomainRun(context, request));
  router.get("/api/pi/skills/:id", (request) => skillResponse(request, context));
}

export function skillResponse(request: Request, context?: SkillRouteContext): Response {
  const id = skillID(request);
  const registry = readRegistry(context);
  const skill = findSkill(registry.items, id);
  if (!skill && id === "jev-assist" && registry.jev) return json({ diagnostics: [], skill: jevSkillView(registry.jev) });
  if (!skill) throw new HttpError(404, `skill 不存在: ${id}`);
  return json({ diagnostics: registry.diagnostics, skill: decoratedSkill(skill, registry, true) });
}

export function domainRunsResponse(context: SkillRouteContext | undefined, request: Request): JsonObject[] {
  const db = requireDatabase(context);
  const params = new URL(request.url).searchParams;
  const skill = cleanParam(params.get("skill_id") || params.get("skillId"));
  const itemID = queryID(params.get("item_id") || params.get("itemId"));
  const status = cleanParam(params.get("status"));
  return domainRunEvents(db)
    .map((event) => domainRunView(db, event))
    .filter((run) => skill === "" || run.skill_id === skill)
    .filter((run) => !itemID || run.item_id === itemID)
    .filter((run) => status === "" || run.status === status)
    .sort((left, right) => positiveInteger(right.id) - positiveInteger(left.id))
    .slice(0, queryLimit(params.get("limit")));
}

export async function startIntakeRun(context: SkillRouteContext | undefined, request: Request): Promise<Response> {
  const db = requireDatabase(context);
  const skill = await requireRuntimeSkill(request, context, "intake");
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

export async function startDomainRun(context: SkillRouteContext | undefined, request: Request): Promise<Response> {
  const db = requireDatabase(context);
  const skill = await requireRuntimeSkill(request, context, "domain");
  const body = await objectBody(request);
  const item = getAttentionInboxItem(db, positiveBodyID(body, "item_id"));
  if (!item) throw new HttpError(404, "attention inbox item not found");
  const result = await runDomainSkillAndMarkProposal(db, item, skill.id, {
    cliConnectorDirs: context?.config?.cliConnectors.manifestDirs ?? [],
    skill
  });
  return json({ action: result.action, item: result.item, run: latestDomainRun(db, result.action.id) }, { status: 202 });
}

export function latestDomainRun(db: RunnerDatabase, actionID: string): JsonObject | null {
  const event = domainRunEvents(db).filter((item) => item.action_id === actionID).at(-1);
  return event ? domainRunView(db, event) : null;
}

export function domainRunView(db: RunnerDatabase, event: PiActionEvent): JsonObject {
  const eventPayload = redactedJsonObject(parseJson(event.payload_json));
  const action = getPiAction(db, event.action_id);
  const actionPayload = redactedJsonObject(parseJson(action?.payload_json));
  const itemID = positiveInteger(eventPayload.item_id || actionPayload.item_id);
  const item = itemID ? getAttentionInboxItem(db, itemID) : null;
  const error = event.error;
  return {
    id: event.id,
    kind: "domain",
    status: cleanString(eventPayload.status) || (error ? "failed" : "succeeded"),
    proposal_status: action?.status || "",
    skill_id: cleanString(eventPayload.skill_id || actionPayload.skill_id) || DEFAULT_DOMAIN_SKILL_ID,
    item_id: itemID,
    bundle_id: item?.bundle_id ?? 0,
    input_id: itemID,
    input_object: "inbox_item",
    primary_intent: cleanString(eventPayload.primary_intent || actionPayload.primary_intent || item?.primary_intent),
    action_count: positiveInteger(eventPayload.action_count),
    proposal_action_id: event.action_id,
    schema_output: actionPayload,
    error,
    diagnostics: runDiagnostics(error),
    links: {
      context_bundle: item ? `/api/pi/attention-inbox/context-bundles/${item.bundle_id}` : "",
      inbox_item: itemID ? `/api/pi/attention-inbox/items/${itemID}` : "",
      proposal: `/api/pi/actions/${encodeURIComponent(event.action_id)}`
    },
    lifecycle: { execution: "executed" },
    created_at: event.created_at,
    updated_at: action?.updated_at || event.created_at
  };
}

export async function requireRuntimeSkill(
  request: Request,
  context: SkillRouteContext | undefined,
  kind: "domain" | "intake"
): Promise<SkillMetadata> {
  const id = skillID(request);
  const registry = readRegistry(context);
  const skill = findSkill(registry.items, id);
  if (!skill) throw new HttpError(404, `skill 不存在: ${id}`);
  if (registry.disabled?.includes(skill.id)) throw new HttpError(409, "技能已停用");
  if (context) {
    const installed = visibleManagedSkills(dirname(context.database.path)).find(item => item.id === skill.id);
    if (installed) {
      try { await validateManagedSkill(dirname(context.database.path), installed); }
      catch { throw new HttpError(409, "技能完整性检查失败，请更新或重新安装"); }
    }
  }
  if (skill.kind !== kind) throw new HttpError(400, `skill kind 必须是 ${kind}`);
  if (kind === "domain" && !skill.execution) throw new HttpError(400, "domain skill 缺少可执行 runtime");
  const diagnostics = skillDiagnostics(skill, registry.diagnostics);
  if (diagnostics.length > 0) throw new HttpError(400, "skill 存在诊断，不能手动运行");
  return skill;
}

export function findSkill(skills: SkillMetadata[], id: string): SkillMetadata | undefined {
  const wanted = normalizeID(id);
  return skills.find((skill) => skill.id === wanted || skill.name === wanted);
}

export async function objectBody(request: Request): Promise<JsonObject> {
  const body = await parseJsonBody(request);
  return body && typeof body === "object" && !Array.isArray(body) ? body as JsonObject : {};
}

export function positiveBodyID(body: JsonObject, field: "bundle_id" | "item_id"): number {
  const camel = field === "bundle_id" ? "bundleId" : "itemId";
  const id = positiveInteger(body[field] || body[camel]);
  if (!id) throw new HttpError(400, `${field} 必须是正整数`);
  return id;
}

export function skillID(request: Request): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const value = parts[parts.indexOf("skills") + 1]?.trim() ?? "";
  if (value === "") throw new HttpError(400, "skill id 不能为空");
  return decodeURIComponent(value);
}

export function normalizeID(value: unknown): string {
  return cleanString(value).toLowerCase().replace(/[^a-z0-9_:-]+/g, "-").replace(/^-+|-+$/g, "");
}
