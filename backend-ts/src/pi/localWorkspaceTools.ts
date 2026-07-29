import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RunnerDatabase } from "../db/database.ts";
import {
  getPiConversation,
  updatePiConversation
} from "../db/repositories/pi.ts";
import {
  getProject,
  listProjects,
  type Project
} from "../db/repositories/projects.ts";
import { createAutomaticallyManagedProject } from "../domain/project/automaticTakeover.ts";
import { formatModelVisibleToolOutput } from "../security/promptInjectionDefense.ts";
import { createPendingPiAction } from "./actionEngine.ts";
import { scopedRunnerChatActionContext } from "./runnerChatAuthorization.ts";
import type { PiRunnerActionContext } from "./runnerActions.ts";

export const PI_LOCAL_WORKSPACE_TOOL_NAMES = [
  "project_create",
  "workspace_make_directory",
  "workspace_write_file"
] as const;

export const PI_LOCAL_WORKSPACE_ACTION_TYPES = [
  "project.create",
  "workspace.make_directory",
  "workspace.write_file"
] as const;

const objectOptions = { additionalProperties: false };
const requiredText = Type.String({ minLength: 1, pattern: "\\S" });
const MAX_TEXT_CHARS = 262_144;
const TOOL_RESULT_MAX_CHARS = 8_192;
const WRITABLE_TEXT_EXTENSIONS = new Set([
  ".csv", ".json", ".md", ".text", ".toml", ".tsv", ".txt", ".yaml", ".yml"
]);
const WRITABLE_TEXT_NAMES = new Set([
  ".editorconfig", ".gitignore", "agents.md", "changelog", "changelog.md", "license", "license.md",
  "notice", "notice.md", "readme", "readme.md"
]);
const SENSITIVE_FILE_PATTERN = /(?:^|[._-])(credential|credentials|password|private[-_]?key|secret|secrets|token|tokens)(?:$|[._-])/i;

type ProjectCreateParams = Static<ReturnType<typeof projectCreateParameters>>;
type WorkspaceDirectoryParams = Static<ReturnType<typeof workspaceDirectoryParameters>>;
type WorkspaceWriteParams = Static<ReturnType<typeof workspaceWriteParameters>>;

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

function projectCreateParameters() {
  return Type.Object({
    cwd: requiredText,
    id: Type.Optional(requiredText),
    name: Type.Optional(requiredText)
  }, objectOptions);
}

function workspaceDirectoryParameters() {
  return Type.Object({
    path: requiredText,
    project_id: Type.Optional(requiredText)
  }, objectOptions);
}

function workspaceWriteParameters() {
  return Type.Object({
    content: Type.String({ maxLength: MAX_TEXT_CHARS }),
    mode: Type.Optional(Type.Union([Type.Literal("create"), Type.Literal("replace")])),
    path: requiredText,
    project_id: Type.Optional(requiredText)
  }, objectOptions);
}

async function createLocalProject(
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

async function makeProjectDirectory(
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

async function writeProjectTextFile(
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

async function writeTextFile(
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

function localTool<TParams extends TSchema>(
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

function toolResult(details: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: formatModelVisibleToolOutput(details, { maxChars: TOOL_RESULT_MAX_CHARS }) }],
    details
  };
}

function normalizeProjectRoot(value: unknown): string {
  const input = cleanString(value);
  if (!isAbsolute(input)) throw new Error("project cwd must be an absolute path");
  const cwd = resolve(input);
  if (cwd === sep || cwd === dirname(cwd)) throw new Error("project cwd cannot be the filesystem root");
  return cwd;
}

function normalizeRelativePath(value: unknown): string {
  const input = cleanString(value).replaceAll("\\", "/");
  if (input === "" || isAbsolute(input)) throw new Error("path must be relative to the project root");
  const normalized = input.replace(/^\.\//, "");
  if (normalized === "" || normalized === "." || normalized.split("/").includes("..")) {
    throw new Error("path must stay inside the project root");
  }
  return normalized;
}

function assertWritableTextPath(path: string): void {
  const name = basename(path).toLowerCase();
  if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example") || SENSITIVE_FILE_PATTERN.test(name)) {
    throw new Error("refusing to write secret or credential files");
  }
  if (!WRITABLE_TEXT_NAMES.has(name) && !WRITABLE_TEXT_EXTENSIONS.has(extname(name))) {
    throw new Error("workspace_write_file is limited to documentation and text/config data; use a coding Work/Run for source files");
  }
}

async function safeWorkspaceTarget(project: Project, path: string) {
  const root = await realpath(project.cwd);
  const absolute = resolve(root, path);
  assertInside(root, absolute);
  if (absolute === root) throw new Error("target must be below the project root");
  return { absolute, root };
}

function assertInside(root: string, target: string, allowRoot = false): void {
  const path = relative(root, target);
  if ((!allowRoot && path === "") || path.startsWith(`..${sep}`) || path === ".." || isAbsolute(path)) {
    throw new Error("target escapes the project root");
  }
}

async function assertNearestExistingParentInside(root: string, target: string): Promise<void> {
  let cursor = dirname(target);
  while (cursor !== root) {
    try {
      const resolved = await realpath(cursor);
      assertInside(root, resolved);
      return;
    } catch (error) {
      if (!isMissingError(error)) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error("project parent is unavailable");
      cursor = parent;
    }
  }
}

async function ensureProjectDirectory(cwd: string): Promise<boolean> {
  try {
    const current = await lstat(cwd);
    if (current.isSymbolicLink()) throw new Error("project cwd cannot be a symbolic link");
    if (!current.isDirectory()) throw new Error("project cwd exists and is not a directory");
    return false;
  } catch (error) {
    if (!isMissingError(error)) throw error;
    await mkdir(cwd, { recursive: true });
    return true;
  }
}

async function fileState(path: string): Promise<{ kind: "file" | "other" | "symlink" } | undefined> {
  try {
    const current = await lstat(path);
    if (current.isSymbolicLink()) return { kind: "symlink" };
    if (current.isFile()) return { kind: "file" };
    return { kind: "other" };
  } catch (error) {
    if (isMissingError(error)) return undefined;
    throw error;
  }
}

function requireTargetProject(db: RunnerDatabase, value: unknown, fallback?: Project): Project {
  const id = cleanString(value) || fallback?.id || "";
  if (id === "") throw new Error("project_id is required when the conversation is not attached to a project");
  const project = getProject(db, id);
  if (!project) throw new Error(`project not found: ${id}`);
  return project;
}

function projectAtPath(db: RunnerDatabase, cwd: string): Project | undefined {
  return listProjects(db).find((project) => resolve(project.cwd) === cwd);
}

function bindConversationProject(db: RunnerDatabase, conversationID: unknown, project: Project): boolean {
  const id = cleanString(conversationID);
  if (id === "") return false;
  const conversation = getPiConversation(db, id);
  if (!conversation) return false;
  if (conversation.project_id === project.id) return true;
  const updated = updatePiConversation(db, id, { project_id: project.id });
  db.sqlite.run(
    "update agent_sessions set project_id=? where provider=? and provider_session_id=?",
    [project.id, "pi-sdk", updated.pi_session_id]
  );
  return true;
}

function projectResult(project: Project, directoryCreated: boolean, attachedExisting: boolean, conversationAttached: boolean) {
  return {
    attached_existing: attachedExisting,
    conversation_attached: conversationAttached,
    directory_created: directoryCreated,
    project: { cwd: project.cwd, id: project.id, name: project.name },
    provider_started: false
  };
}

function fileWriteResult(
  project: Project,
  path: string,
  absolute: string,
  digest: string,
  content: string,
  status: "created" | "replaced" | "unchanged"
) {
  return {
    bytes: Buffer.byteLength(content, "utf8"),
    chars: content.length,
    path: absolute,
    project_id: project.id,
    provider_started: false,
    relative_path: path,
    sha256: digest,
    status
  };
}

function sourcePromptIncludes(context: Omit<PiRunnerActionContext, "project">, cwd: string, projectID: string): boolean {
  const prompt = cleanString(context.sourceTurn?.userPrompt);
  const normalized = prompt.toLowerCase();
  const id = projectID.toLowerCase();
  const token = new RegExp(`(^|[^a-z0-9_-])${escapePattern(id)}($|[^a-z0-9_-])`);
  return prompt.includes(cwd) || normalized.includes(`@project:${id}`) || token.test(normalized);
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanProjectID(value: unknown): string {
  const normalized = cleanString(value).toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  if (normalized === "") throw new Error("project id could not be derived from the requested path");
  return normalized;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function backupStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function isMissingError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
