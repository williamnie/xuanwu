import { type Static, type TSchema } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { copyFile, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { RunnerDatabase } from "../../db/database.ts";
import { type Project } from "../../db/repositories/projects.ts";
import { createPendingPiAction } from "../actions/actionEngine.ts";
import { scopedRunnerChatActionContext } from "../runnerTools/runnerChatAuthorization.ts";
import type { PiRunnerActionContext } from "../runnerTools/runnerActions.ts";
import { WorkspaceDirectoryParams, WorkspaceWriteParams, MAX_TEXT_CHARS, PI_LOCAL_WORKSPACE_TOOL_NAMES } from "./localWorkspaceTools.ts";
import { requireTargetProject, normalizeRelativePath, sourcePromptIncludes, safeWorkspaceTarget, assertNearestExistingParentInside, assertInside, assertWritableTextPath, sha256, fileState, fileWriteResult, backupStamp, toolResult } from "./localWorkspacePaths.ts";

export async function makeProjectDirectory(
  db: RunnerDatabase,
  fallbackProject: Project | undefined,
  context: Omit<PiRunnerActionContext, "project">,
  input: WorkspaceDirectoryParams
) {
  const project = requireTargetProject(db, input.project_id, fallbackProject);
  const path = normalizeRelativePath(input.path);
  const preconditionFailure = sourcePromptIncludes(context, project.cwd, project.id)
    ? ""
    : "the current user turn must explicitly target this project";
  const actionContext = scopedRunnerChatActionContext(context, "workspace.make_directory", { projectID: project.id });
  return createPendingPiAction(db, actionContext, {
    actionType: "workspace.make_directory",
    payload: { path, project_id: project.id },
    preconditionFailure,
    projectID: project.id,
    rationale: `Create project directory ${path}`
  }, async () => {
    const target = await safeWorkspaceTarget(project, path);
    await assertNearestExistingParentInside(target.root, target.absolute);
    await mkdir(target.absolute, { recursive: true });
    const resolved = await realpath(target.absolute);
    assertInside(target.root, resolved);
    return { created: true, path: target.absolute, project_id: project.id, relative_path: path };
  });
}

export async function writeProjectTextFile(
  db: RunnerDatabase,
  fallbackProject: Project | undefined,
  context: Omit<PiRunnerActionContext, "project">,
  input: WorkspaceWriteParams
) {
  const project = requireTargetProject(db, input.project_id, fallbackProject);
  const path = normalizeRelativePath(input.path);
  assertWritableTextPath(path);
  const content = String(input.content ?? "");
  if (content.length > MAX_TEXT_CHARS) throw new Error(`content exceeds ${MAX_TEXT_CHARS} characters`);
  const mode = input.mode === "replace" ? "replace" : "create";
  const digest = sha256(content);
  const preconditionFailure = sourcePromptIncludes(context, project.cwd, project.id)
    ? ""
    : "the current user turn must explicitly target this project";
  const actionContext = scopedRunnerChatActionContext(context, "workspace.write_file", { projectID: project.id });
  return createPendingPiAction(db, actionContext, {
    actionType: "workspace.write_file",
    payload: {
      content_chars: content.length,
      content_sha256: digest,
      mode,
      path,
      project_id: project.id
    },
    preconditionFailure,
    projectID: project.id,
    rationale: `Write project text file ${path}`
  }, async () => writeTextFile(project, path, content, mode, digest));
}

export async function writeTextFile(
  project: Project,
  path: string,
  content: string,
  mode: "create" | "replace",
  digest: string
) {
  const target = await safeWorkspaceTarget(project, path);
  await assertNearestExistingParentInside(target.root, target.absolute);
  await mkdir(dirname(target.absolute), { recursive: true });
  assertInside(target.root, await realpath(dirname(target.absolute)), true);
  const existing = await fileState(target.absolute);
  if (existing?.kind === "symlink") throw new Error("refusing to write through a symbolic link");
  if (existing?.kind === "other") throw new Error("target exists and is not a regular file");
  if (existing?.kind === "file") {
    const previous = await readFile(target.absolute, "utf8");
    if (sha256(previous) === digest) return fileWriteResult(project, path, target.absolute, digest, content, "unchanged");
    if (mode !== "replace") throw new Error("target file already exists; use mode=replace only when the user asked to update it");
  }

  let backupPath = "";
  if (existing?.kind === "file") {
    backupPath = join(target.root, ".xuanwu", "backups", backupStamp(), path);
    await assertNearestExistingParentInside(target.root, backupPath);
    await mkdir(dirname(backupPath), { recursive: true });
    assertInside(target.root, await realpath(dirname(backupPath)), true);
    await copyFile(target.absolute, backupPath);
  }

  if (!existing) {
    await writeFile(target.absolute, content, { encoding: "utf8", flag: "wx" });
  } else {
    const temporary = join(dirname(target.absolute), `.${basename(target.absolute)}.xuanwu-${crypto.randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
      await rename(temporary, target.absolute);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
  return {
    ...fileWriteResult(project, path, target.absolute, digest, content, existing ? "replaced" : "created"),
    ...(backupPath ? { backup_path: backupPath } : {})
  };
}

export function localTool<TParams extends TSchema>(
  name: (typeof PI_LOCAL_WORKSPACE_TOOL_NAMES)[number],
  label: string,
  description: string,
  parameters: TParams,
  executeAction: (params: Static<TParams>) => Promise<unknown> | unknown
): ToolDefinition<TParams> {
  return {
    name,
    label,
    description,
    parameters,
    async execute(_toolCallID, params) {
      const details = await executeAction(params);
      return toolResult(details);
    }
  };
}
