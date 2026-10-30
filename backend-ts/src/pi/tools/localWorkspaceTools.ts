import { Type, type Static } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { rmdir } from "node:fs/promises";
import { basename } from "node:path";
import type { RunnerDatabase } from "../../db/database.ts";
import { type Project } from "../../db/repositories/projects.ts";
import { createAutomaticallyManagedProject } from "../../domain/project/automaticTakeover.ts";
import { createPendingPiAction } from "../actions/actionEngine.ts";
import { scopedRunnerChatActionContext } from "../runnerTools/runnerChatAuthorization.ts";
import type { PiRunnerActionContext } from "../runnerTools/runnerActions.ts";
import { cleanString } from "../../util/values.ts";
import { localTool, makeProjectDirectory, writeProjectTextFile } from "./localWorkspaceActions.ts";
import { normalizeProjectRoot, cleanProjectID, sourcePromptIncludes, projectAtPath, bindConversationProject, projectResult, ensureProjectDirectory } from "./localWorkspacePaths.ts";

export const PI_LOCAL_WORKSPACE_TOOL_NAMES = [
  "project_create",
  "workspace_make_directory",
  "workspace_write_file"
] as const;

export const objectOptions = { additionalProperties: false };

export const requiredText = Type.String({ minLength: 1, pattern: "\\S" });

export const MAX_TEXT_CHARS = 262_144;

export const TOOL_RESULT_MAX_CHARS = 8_192;

export const WRITABLE_TEXT_EXTENSIONS = new Set([
  ".csv", ".json", ".md", ".text", ".toml", ".tsv", ".txt", ".yaml", ".yml"
]);

export const WRITABLE_TEXT_NAMES = new Set([
  ".editorconfig", ".gitignore", "agents.md", "changelog", "changelog.md", "license", "license.md",
  "notice", "notice.md", "readme", "readme.md"
]);

export const SENSITIVE_FILE_PATTERN = /(?:^|[._-])(credential|credentials|password|private[-_]?key|secret|secrets|token|tokens)(?:$|[._-])/i;

export type ProjectCreateParams = Static<ReturnType<typeof projectCreateParameters>>;

export type WorkspaceDirectoryParams = Static<ReturnType<typeof workspaceDirectoryParameters>>;

export type WorkspaceWriteParams = Static<ReturnType<typeof workspaceWriteParameters>>;

export function createPiLocalWorkspaceTools(
  db: RunnerDatabase,
  project?: Project,
  context: Omit<PiRunnerActionContext, "project"> = {}
): ToolDefinition[] {
  return [
    localTool(
      "project_create",
      "Create Local Project",
      "Create or attach one explicitly requested local project directory and register it with Xuanwu. This does not create Work or start a coding provider.",
      projectCreateParameters(),
      (input) => createLocalProject(db, context, input)
    ),
    localTool(
      "workspace_make_directory",
      "Create Project Directory",
      "Create a directory inside a registered project. Use this for simple local organization, not for implementation work.",
      workspaceDirectoryParameters(),
      (input) => makeProjectDirectory(db, project, context, input)
    ),
    localTool(
      "workspace_write_file",
      "Write Project Text File",
      "Create or replace a small documentation/data/config text file inside a registered project. Use this for PRDs, README, notes, JSON/YAML/TOML/CSV; use Work/Run and the selected coding provider for source code or broad changes.",
      workspaceWriteParameters(),
      (input) => writeProjectTextFile(db, project, context, input)
    )
  ];
}

export function projectCreateParameters() {
  return Type.Object({
    cwd: requiredText,
    id: Type.Optional(requiredText),
    name: Type.Optional(requiredText)
  }, objectOptions);
}

export function workspaceDirectoryParameters() {
  return Type.Object({
    path: requiredText,
    project_id: Type.Optional(requiredText)
  }, objectOptions);
}

export function workspaceWriteParameters() {
  return Type.Object({
    content: Type.String({ maxLength: MAX_TEXT_CHARS }),
    mode: Type.Optional(Type.Union([Type.Literal("create"), Type.Literal("replace")])),
    path: requiredText,
    project_id: Type.Optional(requiredText)
  }, objectOptions);
}

export async function createLocalProject(
  db: RunnerDatabase,
  context: Omit<PiRunnerActionContext, "project">,
  input: ProjectCreateParams
) {
  const cwd = normalizeProjectRoot(input.cwd);
  const id = cleanProjectID(input.id || basename(cwd));
  const name = cleanString(input.name) || basename(cwd) || id;
  const preconditionFailure = sourcePromptIncludes(context, cwd, id)
    ? ""
    : "the current user turn must explicitly name the project path or project id";
  const actionContext = scopedRunnerChatActionContext(context, "project.create", { projectID: id });
  return createPendingPiAction(db, actionContext, {
    actionType: "project.create",
    payload: { cwd, id, name },
    preconditionFailure,
    projectID: id,
    rationale: `Create or attach local project ${name}`
  }, async () => {
    const existing = projectAtPath(db, cwd);
    if (existing) {
      const attached = bindConversationProject(db, context.conversationID, existing);
      return projectResult(existing, false, true, attached);
    }
    let directoryCreated = false;
    try {
      directoryCreated = await ensureProjectDirectory(cwd);
      const created = createAutomaticallyManagedProject(db, { cwd, id, name });
      const attached = bindConversationProject(db, context.conversationID, created);
      return projectResult(created, directoryCreated, false, attached);
    } catch (error) {
      if (directoryCreated) await rmdir(cwd).catch(() => {});
      throw error;
    }
  });
}
