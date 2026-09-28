import { loadSkillsFromDir, VERSION } from "@earendil-works/pi-coding-agent";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { RunnerDatabase } from "../db/database.ts";
import { getProject, type Project } from "../db/repositories/projects.ts";
import { loadAssistantToolRegistrySnapshot } from "../pi/toolRegistrySnapshot.ts";
import { libraryRegistryOptions, managedSkillPolicy } from "./libraryContext.ts";
import { readSkillRegistry, resolveSkillFile } from "./registry.ts";
import { currentSkillRevision, readSkillCatalog, validateManagedSkill, visibleManagedSkills } from "./managedStore.ts";
import { assertSkillResourcePath, within } from "./managedSource.ts";
import { SkillLibraryError, type ManagedSkill } from "./managedTypes.ts";
import { buildSkillPromptContext } from "./promptContext.ts";
import { hasBuiltinSkillHandler } from "./runtime.ts";

export function libraryProject(db: RunnerDatabase, projectID?: string): Project | undefined {
  if (!projectID) return undefined;
  const project = getProject(db, projectID);
  if (!project) throw new SkillLibraryError(404, "项目不存在");
  return project;
}

export function libraryTools(db: RunnerDatabase) {
  return loadAssistantToolRegistrySnapshot(db).tools.map(tool => ({
    aliases: typeof tool.metadata?.capability_id === "string" ? [tool.metadata.capability_id] : [],
    name: tool.name, permission: tool.permission, provider_id: tool.provider_id
  }));
}

export function listSkillLibrary(db: RunnerDatabase, projectID?: string) {
  const project = libraryProject(db, projectID), stateDir = dirname(db.path);
  const catalog = readSkillCatalog(stateDir);
  const registry = readSkillRegistry({ ...libraryRegistryOptions(db, project), availableTools: libraryTools(db) });
  const installed = visibleManagedSkills(stateDir, projectID);
  const authorized = new Set(buildSkillPromptContext(db, { project }).audit.injected_skill_ids);
  return {
    generation: catalog.generation,
    pi_version: VERSION,
    project_id: projectID || "",
    installed: installed.map(item => ({ ...publicManagedSkill(item), effective_enabled: item.enabled && authorized.has(item.id) && installed.find(candidate => candidate.id === item.id)?.key === item.key })),
    discovered: registry.items.map(({ instructions: _instructions, ...item }) => item),
    diagnostics: registry.diagnostics,
    supported_sources: ["git", "local", "inline"]
  };
}

export function publicManagedSkill(skill: ManagedSkill) {
  const current = currentSkillRevision(skill);
  return {
    key: skill.key, id: skill.id, scope: skill.scope, project_id: skill.project_id,
    enabled: skill.enabled, revision: skill.revision, digest: current.digest,
    ...(skill.cleanup_pending ? { cleanup_pending: true } : {}),
    source: publicSource(current.source), resolved_ref: current.resolved_ref || "", installed_at: current.installed_at,
    revisions: skill.revisions.map(item => ({ revision: item.revision, digest: item.digest, installed_at: item.installed_at, source: publicSource(item.source), resolved_ref: item.resolved_ref || "" }))
  };
}

function publicSource(source: ManagedSkill["revisions"][number]["source"]) {
  const { content: _content, ...publicFields } = source;
  return publicFields;
}

export function requireManagedSkill(db: RunnerDatabase, key: string): ManagedSkill {
  const skill = readSkillCatalog(dirname(db.path)).skills.find(item => item.key === key);
  if (!skill) throw new SkillLibraryError(404, "技能未安装或已卸载");
  return skill;
}

export async function verifyLibrarySkill(db: RunnerDatabase, key: string) {
  const skill = requireManagedSkill(db, key);
  let validated;
  try { validated = await validateManagedSkill(dirname(db.path), skill); }
  catch (error) {
    return { id: skill.id, key: skill.key, revision: skill.revision, status: "blocked", checks: { integrity: false, metadata: false, sdk_load: false, tools: false },
      diagnostics: [{ code: "validation_failed", message: error instanceof SkillLibraryError ? error.message : "无法读取技能文件" }], files: [], scripts: [], execution: "unavailable", execution_verified: false,
      note: "技能文件验证失败；可更新、重新安装或卸载，当前版本不会被加载。" };
  }
  const loaded = loadSkillsFromDir({ dir: validated.directory, source: "xuanwu-library" });
  const registry = readSkillRegistry({ roots: [{ label: "installed", path: validated.directory }], availableTools: libraryTools(db) });
  const diagnostics = [...registry.diagnostics, ...loaded.diagnostics.map(item => ({ code: `sdk_${item.type}`, message: item.message }))];
  if (validated.metadata.kind === "domain" && !validated.metadata.execution) diagnostics.push({ code: "manifest_only", message: "Domain skill 缺少可执行 handler" });
  if (validated.metadata.execution && !hasBuiltinSkillHandler(validated.metadata.execution.handler)) diagnostics.push({ code: "handler_not_allowed", message: "技能声明的 handler 未在玄武中注册" });
  const valid = loaded.skills.some(item => item.name === skill.id) && diagnostics.length === 0;
  return {
    id: skill.id, key: skill.key, revision: skill.revision,
    status: !valid ? "blocked" : skill.enabled ? "ready" : "disabled",
    checks: { integrity: true, metadata: true, sdk_load: loaded.skills.some(item => item.name === skill.id), tools: registry.diagnostics.every(item => item.code !== "missing_tool" && item.code !== "permission_conflict") },
    diagnostics,
    files: validated.files,
    scripts: validated.files.filter(file => file.startsWith("scripts/")),
    execution: validated.metadata.execution ? "registered_handler" : "instructions",
    execution_verified: false,
    note: "已验证文件、Pi 加载和工具依赖；实际任务执行结果以会话工具调用或技能运行记录为准。"
  };
}

export async function readLibrarySkillResource(db: RunnerDatabase, id: string, file = "SKILL.md", project?: Project) {
  assertSkillResourcePath(file);
  const managed = visibleManagedSkills(dirname(db.path), project?.id).find(item => item.id === id);
  if (managed) {
    if (!managed.enabled) throw new SkillLibraryError(409, "技能已停用，请先启用");
    const verified = await verifyLibrarySkill(db, managed.key);
    if (verified.status === "blocked") throw new SkillLibraryError(409, `技能依赖或加载检查失败：${verified.diagnostics.map(item => item.message).join("；")}`);
  }
  const entry = resolveSkillFile(id, libraryRegistryOptions(db, project));
  if (!entry) throw new SkillLibraryError(404, "技能不存在");
  const root = await realpath(dirname(entry));
  const path = await realpath(resolve(root, file)).catch(() => { throw new SkillLibraryError(404, "技能资源不存在"); });
  if (!within(root, path)) throw new SkillLibraryError(400, "资源路径必须位于技能目录内");
  const info = await stat(path);
  if (!info.isFile() || info.size > 128 * 1024) throw new SkillLibraryError(400, "资源须为不超过 128 KiB 的文本文件");
  const content = await readFile(path, "utf8");
  if (content.includes("\0")) throw new SkillLibraryError(400, "不支持读取二进制资源");
  return { id, file, content, base_directory: root, revision: managed?.revision || "", enabled: !managedSkillPolicy(db, project?.id).disabled.includes(id) };
}
