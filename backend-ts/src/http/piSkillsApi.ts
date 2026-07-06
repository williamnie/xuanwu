import type { RunnerConfig } from "../config/env.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { loadAssistantToolRegistrySnapshot } from "../pi/toolRegistrySnapshot.ts";
import { readSkillRegistry, type SkillMetadata } from "../skills/registry.ts";
import { HttpError, json } from "./errors.ts";
import type { Router } from "./router.ts";

type SkillRouteContext = { config?: RunnerConfig; database: RunnerDatabase };

export function registerPiSkillRoutes(router: Router, context?: SkillRouteContext): void {
  router.get("/api/pi/skills", () => skillsResponse(context));
  router.get("/api/pi/skills/:id", (request) => skillResponse(request, context));
}

function skillsResponse(context?: SkillRouteContext): Response {
  const registry = readRegistry(context);
  return json({ diagnostics: registry.diagnostics, skills: registry.items });
}

function skillResponse(request: Request, context?: SkillRouteContext): Response {
  const id = skillID(request);
  const registry = readRegistry(context);
  const skill = findSkill(registry.items, id);
  if (!skill) throw new HttpError(404, `skill 不存在: ${id}`);
  return json({ diagnostics: registry.diagnostics, skill });
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

function skillID(request: Request): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const value = parts[parts.indexOf("skills") + 1]?.trim() ?? "";
  if (value === "") throw new HttpError(400, "skill id 不能为空");
  return decodeURIComponent(value);
}

function normalizeID(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_:-]+/g, "-").replace(/^-+|-+$/g, "");
}
