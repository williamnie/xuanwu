import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { RunnerDatabase } from "../../db/database.ts";
import { getPiConversation, updatePiConversation } from "../../db/repositories/pi.ts";
import { getProject, listProjects, type Project } from "../../db/repositories/projects.ts";
import { formatModelVisibleToolOutput } from "../../security/promptInjectionDefense.ts";
import type { PiRunnerActionContext } from "../runnerTools/runnerActions.ts";
import { cleanString } from "../../util/values.ts";
import { TOOL_RESULT_MAX_CHARS, SENSITIVE_FILE_PATTERN, WRITABLE_TEXT_NAMES, WRITABLE_TEXT_EXTENSIONS } from "./localWorkspaceTools.ts";

export function toolResult(details: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: formatModelVisibleToolOutput(details, { maxChars: TOOL_RESULT_MAX_CHARS }) }],
    details
  };
}

export function normalizeProjectRoot(value: unknown): string {
  const input = cleanString(value);
  if (!isAbsolute(input)) throw new Error("project cwd must be an absolute path");
  const cwd = resolve(input);
  if (cwd === sep || cwd === dirname(cwd)) throw new Error("project cwd cannot be the filesystem root");
  return cwd;
}

export function normalizeRelativePath(value: unknown): string {
  const input = cleanString(value).replaceAll("\\", "/");
  if (input === "" || isAbsolute(input)) throw new Error("path must be relative to the project root");
  const normalized = input.replace(/^\.\//, "");
  if (normalized === "" || normalized === "." || normalized.split("/").includes("..")) {
    throw new Error("path must stay inside the project root");
  }
  return normalized;
}

export function assertWritableTextPath(path: string): void {
  const name = basename(path).toLowerCase();
  if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example") || SENSITIVE_FILE_PATTERN.test(name)) {
    throw new Error("refusing to write secret or credential files");
  }
  if (!WRITABLE_TEXT_NAMES.has(name) && !WRITABLE_TEXT_EXTENSIONS.has(extname(name))) {
    throw new Error("workspace_write_file is limited to documentation and text/config data; use a coding Work/Run for source files");
  }
}

export async function safeWorkspaceTarget(project: Project, path: string) {
  const root = await realpath(project.cwd);
  const absolute = resolve(root, path);
  assertInside(root, absolute);
  if (absolute === root) throw new Error("target must be below the project root");
  return { absolute, root };
}

export function assertInside(root: string, target: string, allowRoot = false): void {
  const path = relative(root, target);
  if ((!allowRoot && path === "") || path.startsWith(`..${sep}`) || path === ".." || isAbsolute(path)) {
    throw new Error("target escapes the project root");
  }
}

export async function assertNearestExistingParentInside(root: string, target: string): Promise<void> {
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

export async function ensureProjectDirectory(cwd: string): Promise<boolean> {
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

export async function fileState(path: string): Promise<{ kind: "file" | "other" | "symlink" } | undefined> {
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

export function requireTargetProject(db: RunnerDatabase, value: unknown, fallback?: Project): Project {
  const id = cleanString(value) || fallback?.id || "";
  if (id === "") throw new Error("project_id is required when the conversation is not attached to a project");
  const project = getProject(db, id);
  if (!project) throw new Error(`project not found: ${id}`);
  return project;
}

export function projectAtPath(db: RunnerDatabase, cwd: string): Project | undefined {
  return listProjects(db).find((project) => resolve(project.cwd) === cwd);
}

export function bindConversationProject(db: RunnerDatabase, conversationID: unknown, project: Project): boolean {
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

export function projectResult(project: Project, directoryCreated: boolean, attachedExisting: boolean, conversationAttached: boolean) {
  return {
    attached_existing: attachedExisting,
    conversation_attached: conversationAttached,
    directory_created: directoryCreated,
    project: { cwd: project.cwd, id: project.id, name: project.name },
    provider_started: false
  };
}

export function fileWriteResult(
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

export function sourcePromptIncludes(context: Omit<PiRunnerActionContext, "project">, cwd: string, projectID: string): boolean {
  const prompt = cleanString(context.sourceTurn?.userPrompt);
  const normalized = prompt.toLowerCase();
  const id = projectID.toLowerCase();
  const token = new RegExp(`(^|[^a-z0-9_-])${escapePattern(id)}($|[^a-z0-9_-])`);
  return prompt.includes(cwd) || normalized.includes(`@project:${id}`) || token.test(normalized);
}

export function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function cleanProjectID(value: unknown): string {
  const normalized = cleanString(value).toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  if (normalized === "") throw new Error("project id could not be derived from the requested path");
  return normalized;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function backupStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function isMissingError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
