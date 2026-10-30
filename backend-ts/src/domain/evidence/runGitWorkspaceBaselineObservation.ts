import { createHash } from "node:crypto";
import { type WorkspaceBaseline, type WorkspaceEntry } from "./runGitWorkspaceBaseline.ts";

export const ISSUE_RUN_GIT_WORKSPACE_BASELINE_CONTRACT = "xw.issue-run-git-workspace-baseline.v1";

export function workspaceBaseline(input: {
  base_revision: string;
  captured_at: string;
  repository_path: string;
  run_id: string;
}): WorkspaceBaseline {
  const baseRevision = input.base_revision.trim().toLowerCase();
  if (!gitObjectID(baseRevision)) throw new Error("Run Git base revision must be a full object id");
  const entries = workspaceEntries(input.repository_path);
  const canonical = JSON.stringify(entries);
  return {
    base_revision: baseRevision,
    captured_at: canonicalTimestamp(input.captured_at),
    contract: ISSUE_RUN_GIT_WORKSPACE_BASELINE_CONTRACT,
    entries,
    run_id: requiredText(input.run_id, "Run id"),
    snapshot_sha256: createHash("sha256").update(`${canonical}\n`).digest("hex")
  };
}

function workspaceEntries(repositoryPath: string): WorkspaceEntry[] {
  const result = Bun.spawnSync({
    cmd: [
      "git", "status", "--porcelain=v1", "-z", "--no-renames",
      "--untracked-files=all", "--ignored=no", "--"
    ],
    cwd: repositoryPath,
    stderr: "pipe",
    stdout: "pipe"
  });
  if (result.exitCode !== 0) throw new Error("Git workspace status is unavailable");
  return result.stdout.toString().split("\0").filter(Boolean).map((field) => {
    if (field.length < 4 || field[2] !== " ") throw new Error("Git workspace status is malformed");
    const status = field.slice(0, 2);
    const path = normalizedPath(field.slice(3));
    return {
      content_oid: worktreeObjectID(repositoryPath, path),
      path,
      status
    };
  }).sort(compareWorkspaceEntry);
}

function worktreeObjectID(repositoryPath: string, path: string): string {
  const result = Bun.spawnSync({
    cmd: ["git", "hash-object", "--no-filters", "--", path],
    cwd: repositoryPath,
    stderr: "ignore",
    stdout: "pipe"
  });
  const value = result.exitCode === 0 ? result.stdout.toString().trim().toLowerCase() : "";
  return gitObjectID(value) ? value : "missing";
}

export function changedPathsBetween(repositoryPath: string, baseRevision: string, headRevision: string): string[] {
  if (baseRevision === headRevision) return [];
  const result = Bun.spawnSync({
    cmd: [
      "git", "diff", "--name-only", "--no-ext-diff", "--no-renames", "-z",
      baseRevision, headRevision, "--"
    ],
    cwd: repositoryPath,
    stderr: "ignore",
    stdout: "pipe"
  });
  if (result.exitCode !== 0) return [];
  return [...new Set(result.stdout.toString().split("\0").filter(Boolean).map(normalizedPath))].sort();
}

export function gitOutput(repositoryPath: string, args: string[]): string {
  try {
    const result = Bun.spawnSync({
      cmd: ["git", ...args],
      cwd: repositoryPath,
      stderr: "ignore",
      stdout: "pipe"
    });
    return result.exitCode === 0 ? result.stdout.toString().trim().toLowerCase() : "";
  } catch {
    return "";
  }
}

export function revisionBefore(repositoryPath: string, timestamp: string): string {
  const revision = gitOutput(repositoryPath, ["rev-list", "-1", `--before=${timestamp}`, "HEAD"]);
  return gitObjectID(revision) ? revision : "";
}

export function entrySignature(entry: WorkspaceEntry): string {
  return `${entry.status}\0${entry.content_oid}`;
}

export function compareWorkspaceEntry(left: WorkspaceEntry, right: WorkspaceEntry): number {
  return Buffer.from(left.path).compare(Buffer.from(right.path));
}

export function gitObjectID(value: string): boolean {
  return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.trim().toLowerCase());
}

export function normalizedPath(value: string): string {
  const path = requiredText(value, "workspace path").replaceAll("\\", "/");
  if (path.startsWith("/") || path === ".." || path.startsWith("../") || path.includes("/../")) {
    throw new Error("workspace path escapes the repository");
  }
  return path;
}

export function workspaceStatus(value: unknown): string {
  if (typeof value !== "string" || value.length !== 2 || value === "  " ||
    !/^[ MADRCUT?!]{2}$/.test(value)) {
    throw new Error("workspace status must be a two-character Git porcelain status");
  }
  return value;
}

export function canonicalTimestamp(value: unknown): string {
  const text = requiredText(value, "timestamp");
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) throw new Error("timestamp must be ISO-8601");
  return date.toISOString();
}

export function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value.trim();
}
