import type { RunnerDatabase } from "../../db/database.ts";
import { listIntakeRuns, type IntakeRunStatus } from "../../db/repositories/intakeRuns.ts";
import { listPiActionEvents, type PiActionEvent } from "../../db/repositories/pi.ts";
import { loadAssistantToolRegistrySnapshot } from "../../pi/tools/toolRegistrySnapshot.ts";
import type { AssistantTool } from "../../pi/tools/toolProviderEnvelope.ts";
import { readSkillRegistry, type SkillMetadata, type SkillRegistryDiagnostic } from "../../skills/registry.ts";
import { SKILL_RUNTIME_COMPLETED_EVENT } from "../../skills/runtime.ts";
import { HttpError, json } from "../errors.ts";
import { publicIntakeRun } from "./piSkillRunViews.ts";
import { publicJevSkillSettings } from "../settings/jevSkillSettingsApi.ts";
import { libraryRegistryOptions, managedSkillPolicy } from "../../skills/libraryContext.ts";
import { cleanString } from "../../util/values.ts";
import type { SkillRouteContext, JsonObject, SkillRegistryView } from "./piSkillsApi.model.ts";

export const RUN_STATUSES = new Set(["running", "succeeded", "failed"]);

export function skillsResponse(context?: SkillRouteContext): Response {
  const registry = readRegistry(context);
  return json({ diagnostics: registry.diagnostics, skills: decorateSkills(registry, false) });
}

export function intakeRunsResponse(context: SkillRouteContext | undefined, request: Request): JsonObject[] {
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

export function domainRunEvents(db: RunnerDatabase): PiActionEvent[] {
  return listPiActionEvents(db, { eventType: SKILL_RUNTIME_COMPLETED_EVENT })
    .filter((event) => cleanString(jsonObject(parseJson(event.payload_json)).kind) === "domain");
}

export function decorateSkills(registry: SkillRegistryView, includeInstructions: boolean): JsonObject[] {
  const items = registry.items.map((skill) => decoratedSkill(skill, registry, includeInstructions));
  if (registry.jev && !registry.items.some(skill => skill.id === "jev-assist")) items.push(jevSkillView(registry.jev));
  return items;
}

export function jevSkillView(settings: Record<string, unknown>): JsonObject {
  return { id: "jev-assist", name: "Jev 辅助判断", description: "可选的报告分类与信息完整性判断；不可用时继续正常处理任务。",
    optional: true, enabled: settings.enabled, installed: settings.installed, availability_status: settings.availability,
    runtime_status: "optional", discovery_status: settings.installed ? "discovered" : "missing", executable: false,
    required_tools: ["jev-assist:tool:jev_classify_report"] };
}

export function decoratedSkill(
  skill: SkillMetadata,
  registry: SkillRegistryView,
  includeInstructions: boolean
): JsonObject {
  const diagnostics = skillDiagnostics(skill, registry.diagnostics);
  const executable = Boolean(skill.execution);
  const manifestOnly = skill.kind === "domain" && !executable;
  const resolvedTools = skill.required_tools.flatMap((grant) => {
    const tool = resolveTool(registry.tools, grant);
    return tool ? [publicResolvedTool(grant, tool)] : [];
  });
  const missingCapabilities = skill.required_tools.filter((grant) => !resolveTool(registry.tools, grant));
  const disabled = registry.disabled?.includes(skill.id) === true;
  const availability = disabled ? "disabled" : diagnostics.length > 0 || manifestOnly ? "blocked" : "ready";
  const { instructions, ...metadata } = skill;
  return {
    ...metadata,
    ...(includeInstructions ? { instructions } : {}),
    availability_status: availability,
    diagnostics,
    discovery_status: "discovered",
    enabled: !disabled && (skill.kind ? diagnostics.length === 0 && !manifestOnly : true),
    executable,
    lifecycle: {
      availability,
      discovery: "discovered",
      execution: "not_executed",
      load: includeInstructions ? "loaded" : "not_loaded"
    },
    load_status: includeInstructions ? "loaded" : "not_loaded",
    missing_capabilities: missingCapabilities,
    resolved_tools: resolvedTools,
    runtime_status: manifestOnly
      ? "manifest_only"
      : skill.kind ? (diagnostics.length === 0 ? "enabled" : "diagnostic") : "metadata_only",
    ...(skill.id === "jev-assist" && registry.jev ? jevSkillView(registry.jev) : {})
  };
}

export function skillDiagnostics(skill: SkillMetadata, diagnostics: SkillRegistryDiagnostic[]): SkillRegistryDiagnostic[] {
  const path = skill.runtime_manifest_path || skill.source_path;
  return diagnostics.filter((item) => item.source_path === path || item.source_path === skill.source_path);
}

export function readRegistry(context?: SkillRouteContext): SkillRegistryView {
  if (!context) return { ...readSkillRegistry(), tools: [] };
  const snapshot = loadAssistantToolRegistrySnapshot(context.database, {
    cliConnectorDirs: context.config?.cliConnectors.manifestDirs ?? []
  });
  const availableTools = snapshot.tools.map((tool) => ({
    aliases: toolAliases(tool.metadata),
    name: tool.name,
    permission: tool.permission,
    provider_id: tool.provider_id
  }));
  return { ...readSkillRegistry({ ...libraryRegistryOptions(context.database), availableTools }), disabled: managedSkillPolicy(context.database).disabled, tools: snapshot.tools, jev: publicJevSkillSettings(context.database) };
}

export function resolveTool(tools: AssistantTool[], grant: string): AssistantTool | undefined {
  const matches = tools.filter((tool) => (
    tool.name === grant ||
    `${tool.provider_id}:${tool.name}` === grant ||
    cleanString(tool.metadata?.capability_id) === grant
  ));
  return matches.length === 1 ? matches[0] : undefined;
}

export function publicResolvedTool(grant: string, tool: AssistantTool): JsonObject {
  return {
    capability_id: cleanString(tool.metadata?.capability_id),
    grant,
    name: tool.name,
    permission: tool.permission,
    provider_id: tool.provider_id,
    status: "resolved"
  };
}

export function toolAliases(metadata: Record<string, unknown> | undefined): string[] {
  const capabilityID = cleanString(metadata?.capability_id);
  return capabilityID === "" ? [] : [capabilityID];
}

export function runStatus(value: string | null): IntakeRunStatus | undefined {
  const status = cleanParam(value);
  if (status === "") return undefined;
  if (!RUN_STATUSES.has(status)) throw new HttpError(400, "run status 不合法");
  return status as IntakeRunStatus;
}

export function queryID(value: string | null): number | undefined {
  const id = Number(cleanParam(value));
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export function queryLimit(value: string | null): number {
  const limit = Number(cleanParam(value));
  return Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 50;
}

export function parseJson(value: unknown): unknown {
  try { return JSON.parse(cleanString(value) || "{}"); } catch { return {}; }
}

export function jsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

export function requireDatabase(context?: SkillRouteContext): RunnerDatabase {
  if (!context?.database) throw new HttpError(503, "database is required");
  return context.database;
}

export function cleanParam(value: string | null): string {
  return value?.trim() ?? "";
}
