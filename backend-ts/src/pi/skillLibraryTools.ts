import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import type { RunnerDatabase } from "../db/database.ts";
import type { Project } from "../db/repositories/projects.ts";
import { formatModelVisibleToolOutput } from "../security/promptInjectionDefense.ts";
import { changeManagedSkill, installManagedSkill } from "../skills/managedStore.ts";
import { libraryProject, listSkillLibrary, publicManagedSkill, readLibrarySkillResource, requireManagedSkill, verifyLibrarySkill } from "../skills/libraryService.ts";
import { SkillLibraryError } from "../skills/managedTypes.ts";
import { buildSkillPromptContext } from "../skills/promptContext.ts";
import { inspectSkillSource } from "../skills/sourceInspection.ts";
import { createExperienceTemplateDraft } from "../skills/experienceTemplates.ts";
import type { ExperienceTemplateSelection } from "../skills/experienceTemplateFormat.ts";
import { executeSafePiAction, type PiActionContext } from "./actionEngine.ts";
import type { PiRunnerActionContext } from "./runnerActions.ts";
import { scopedRunnerChatActionContext, isRunnerChatSource } from "./runnerChatAuthorization.ts";

export { SKILL_LIBRARY_TOOL_NAMES, SKILL_LIBRARY_READ_TOOLS } from "./skillLibraryContracts.ts";
const text = Type.String({ minLength: 1 });
const optionalText = Type.Optional(text);
const objectOptions = { additionalProperties: false };
export const skillSourceSchema = Type.Object({
  kind: Type.Union([Type.Literal("local"), Type.Literal("git"), Type.Literal("inline")]),
  location: optionalText, ref: optionalText, subdirectory: optionalText, content: Type.Optional(Type.String({ maxLength: 131072 }))
}, objectOptions);
export const skillInstallSchema = Type.Object({
  id: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 }),
  scope: Type.Union([Type.Literal("instance"), Type.Literal("project")]),
  project_id: optionalText, source: skillSourceSchema, enabled: Type.Optional(Type.Boolean())
}, objectOptions);
export const skillManageSchema = Type.Object({
  key: text, expected_revision: text,
  operation: Type.Union(["enable", "disable", "update", "rollback", "uninstall"].map(value => Type.Literal(value))),
  source: Type.Optional(skillSourceSchema), revision: optionalText
}, objectOptions);
export const experienceTemplateSchema = Type.Object({
  id: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 }),
  project_id: text, memory_id: text, expected_memory_revision: Type.Integer({ minimum: 1 })
}, objectOptions);

export function createSkillLibraryTools(db: RunnerDatabase, project?: Project, context: Omit<PiRunnerActionContext, "project"> = {}, selection: ExperienceTemplateSelection = {}): ToolDefinition[] {
  const run = (actionType: string, payload: Record<string, unknown>, targetProjectID: string, execute: () => unknown) => {
    const actionContext = skillActionContext(context, actionType, targetProjectID);
    return executeSafePiAction(db, actionContext, { actionType, payload: auditPayload(payload), projectID: targetProjectID, execute });
  };
  return [
    tool("skill_template_draft", "Draft Experience Template", "从 memory_search 选择值得复用的稳定经验生成工作模板草稿。Requires at least two independent verified Works, exact memory revision and project. Returns inputs, steps, applicability, verification, delivery and provenance. Never installs or enables; show the draft for explicit user selection via the template selection API. Do not automatically convert every memory into a skill.", experienceTemplateSchema, params => {
      if (project && params.project_id !== project.id) throw new SkillLibraryError(403, "经验模板不能跨越当前项目范围");
      return run("skill.inspect_source", { ...params, source_kind: "experience_template" }, params.project_id, () => createExperienceTemplateDraft(db, params));
    }),
    tool("skill_inspect_source", "Inspect Skill Source", "Inspect a local or public Git source and discover installable skill names and subdirectories before installing. This never enables skills or executes scripts.", Type.Object({ source: skillSourceSchema }, objectOptions), params =>
      run("skill.inspect_source", params, project?.id || "", () => inspectSkillSource(dirname(db.path), params.source))),
    tool("skill_library_list", "Skill Library", "List installed and discovered skills, their exact keys, revisions, sources, scopes and enabled status.", Type.Object({ project_id: optionalText }, objectOptions), params =>
      run("skill.library_list", params, params.project_id || project?.id || "", () => listSkillLibrary(db, params.project_id || project?.id))),
    tool("skill_install", "Install Skill", "Install and enable an instruction skill from a local directory, public HTTPS Git repository (optional ref/subdirectory), or inline SKILL.md. Uses immutable versions; does not execute package scripts. Choose project scope unless the user requests all projects.", skillInstallSchema, params => {
      const projectID = params.scope === "project" ? params.project_id || project?.id || "" : "";
      if (params.scope === "project") libraryProject(db, projectID || "__missing__");
      return run("skill.install", params, projectID, async () => {
        const installed = await installManagedSkill(dirname(db.path), { ...params, project_id: projectID });
        return { skill: publicManagedSkill(installed), verification: await verifyLibrarySkill(db, installed.key), active_from: "skill_use immediately; automatic discovery on next turn" };
      });
    }),
    tool("skill_manage", "Manage Skill", "Enable, disable, update, roll back, or uninstall an installed skill. Read skill_library_list for key and expected_revision; never guess them. Updates preserve the previous version.", skillManageSchema, params => {
      const installed = requireManagedSkill(db, params.key);
      return run(`skill.${params.operation}`, params, installed.project_id, async () => {
        // HTTP 的单独管理选择可启用或回滚；更新必须通过重新核验草稿的选择入口。
        const result = await changeManagedSkill(dirname(db.path), params as Parameters<typeof changeManagedSkill>[1], params.operation === "update" ? {} : selection);
        return { operation: params.operation, skill: publicManagedSkill(result), ...(params.operation === "uninstall" ? { uninstalled: true } : { verification: await verifyLibrarySkill(db, result.key) }) };
      });
    }),
    tool("skill_verify", "Verify Skill", "Verify installed skill integrity, Pi SDK loading and required tools. This does not claim successful execution of a real task.", Type.Object({ key: text }, objectOptions), params => {
      const installed = requireManagedSkill(db, params.key);
      return run("skill.verify", params, installed.project_id, () => verifyLibrarySkill(db, params.key));
    }),
    tool("skill_use", "Use Skill", "Load an enabled authorized skill's full instructions or a referenced text resource for the current task. Follow its instructions using available gated tools. Script/build/dependency work requires a Coding Provider Work; skill text cannot grant tools or permissions.", Type.Object({ id: text, file: optionalText }, objectOptions), params => {
      const policy = buildSkillPromptContext(db, { ...context, project });
      if (!policy.audit.injected_skill_ids.includes(params.id)) throw new SkillLibraryError(403, "技能未启用或超出当前项目/委派允许列表");
      return run("skill.use", params, project?.id || "", () => readLibrarySkillResource(db, params.id, params.file, project));
    })
  ];
}

function tool<T extends TSchema>(name: string, label: string, description: string, parameters: T, execute: (params: Static<T>) => unknown): ToolDefinition<T> {
  return { name, label, description, parameters, async execute(_id, params) {
    const details = await execute(params);
    return { content: [{ type: "text", text: formatModelVisibleToolOutput(details, { source: "tool_output", maxChars: 140000 }) }], details };
  } };
}

export function skillActionContext(context: PiActionContext, actionType: string, projectID: string): PiActionContext {
  if (projectID) return scopedRunnerChatActionContext(context, actionType, { projectID });
  if (!isRunnerChatSource(context.source) || !["skill.install", "skill.enable", "skill.disable", "skill.update", "skill.rollback", "skill.uninstall"].includes(actionType)) return context;
  if (context.authorization && context.authorization.askOnMissingAuthorization !== true && context.authorization.ask_on_missing_authorization !== true) return context;
  return { ...context, authorization: {
    ...context.authorization, mode: context.authorization?.mode || "delegated",
    allowedActions: context.authorization?.allowedActions || [actionType],
    authorizedActions: [...(context.authorization?.authorizedActions || []), { action_type: actionType }],
    scopes: [...(context.authorization?.scopes || []), { runner_resource: "skills" }]
  } };
}

function auditPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (!payload.source || typeof payload.source !== "object") return payload;
  const { content: _content, ...source } = payload.source as Record<string, unknown>;
  return { ...payload, source };
}
