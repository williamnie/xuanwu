import { readSkillRegistry, type SkillMetadata } from "../skills/registry.ts";
import { HttpError, json } from "./errors.ts";
import type { Router } from "./router.ts";

export function registerPiSkillRoutes(router: Router): void {
  router.get("/api/pi/skills", () => skillsResponse());
  router.get("/api/pi/skills/:id", (request) => skillResponse(request));
}

function skillsResponse(): Response {
  const registry = readSkillRegistry();
  return json({ diagnostics: registry.diagnostics, skills: registry.items });
}

function skillResponse(request: Request): Response {
  const id = skillID(request);
  const registry = readSkillRegistry();
  const skill = findSkill(registry.items, id);
  if (!skill) throw new HttpError(404, `skill 不存在: ${id}`);
  return json({ diagnostics: registry.diagnostics, skill });
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
