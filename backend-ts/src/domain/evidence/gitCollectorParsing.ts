import { Buffer } from "node:buffer";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { type EvidenceArtifactRef } from "./contracts.ts";
import {
  type CollectGitEvidenceInput,
  GIT_UNTRACKED_POLICIES,
  OBJECT_ID_PATTERN,
  type GitUntrackedPolicy,
  type GitStatusSummary,
  type GitDiffSummary,
  type GitChangedFileDiff
} from "./gitCollectorModel.ts";

export function validateInput(input: CollectGitEvidenceInput): void {
  cleanRequiredText(input.repository_path, "Git repository path");
  if (input.untracked_policy && !GIT_UNTRACKED_POLICIES.includes(input.untracked_policy)) {
    throw new Error("unsupported Git untracked policy");
  }
  if (input.base_revision !== undefined) normalizedObjectID(input.base_revision, "Git base revision");
  normalizedPathspecs(input.pathspecs);
}

export function repositoryRootPath(value: string): string {
  const path = resolve(cleanRequiredText(value, "Git repository path"));
  let root: string;
  try {
    root = realpathSync(path);
  } catch {
    throw new Error("Git repository path does not exist");
  }
  if (!statSync(root).isDirectory() || !existsSync(join(root, ".git"))) {
    throw new Error("repository_path must point to a Git working tree root");
  }
  return root;
}

export function normalizedBaseRevision(value: string | undefined, headRevision: string | null): string | null {
  return value === undefined ? headRevision : normalizedObjectID(value, "Git base revision");
}

export function normalizedObjectID(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!OBJECT_ID_PATTERN.test(normalized)) throw new Error(`${label} must be a full 40- or 64-character object id`);
  return normalized;
}

export function diffArguments(baseRevision: string | null, pathspecs: readonly string[]): string[] {
  const options = ["--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", "-z"];
  return baseRevision
    ? ["diff", ...options, baseRevision, "--", ...pathspecs]
    : ["diff", "--cached", ...options, "--", ...pathspecs];
}

export function parseGitStatus(output: Buffer, policy: GitUntrackedPolicy): GitStatusSummary {
  const fields = nulFields(output);
  const paths: string[] = [];
  let stagedChangeCount = 0;
  let unstagedChangeCount = 0;
  let conflictCount = 0;
  let untrackedCount = 0;
  let trackedDirty = false;

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.length < 3 || field[2] !== " ") throw new Error("Git status returned malformed porcelain output");
    const indexStatus = field[0]!;
    const worktreeStatus = field[1]!;
    const path = field.slice(3);
    if (path === "") throw new Error("Git status returned an empty changed path");
    paths.push(path);

    if (indexStatus === "?" && worktreeStatus === "?") {
      untrackedCount += 1;
      continue;
    }
    trackedDirty = true;
    if (indexStatus !== " " && indexStatus !== "!") stagedChangeCount += 1;
    if (worktreeStatus !== " " && worktreeStatus !== "!") unstagedChangeCount += 1;
    if (indexStatus === "U" || worktreeStatus === "U" || ["DD", "AA"].includes(`${indexStatus}${worktreeStatus}`)) {
      conflictCount += 1;
    }
    if (indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C") {
      const originalPath = fields[index + 1];
      if (!originalPath) throw new Error("Git status returned a rename without its original path");
      paths.push(originalPath);
      index += 1;
    }
  }

  return {
    conflict_count: conflictCount,
    dirty: fields.length > 0,
    paths: sortedUnique(paths),
    staged_change_count: stagedChangeCount,
    tracked_dirty: trackedDirty,
    unstaged_change_count: unstagedChangeCount,
    untracked_count: policy === "include_all" ? untrackedCount : null
  };
}

export function parseGitNumstat(output: Buffer): GitDiffSummary {
  const files: GitChangedFileDiff[] = [];
  const paths: string[] = [];
  let insertions = 0;
  let deletions = 0;
  let binaryFileCount = 0;
  const records = nulFields(output);
  for (const record of records) {
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab < 1 || secondTab < firstTab + 2 || secondTab === record.length - 1) {
      throw new Error("Git diff returned malformed numstat output");
    }
    const added = record.slice(0, firstTab);
    const removed = record.slice(firstTab + 1, secondTab);
    const path = record.slice(secondTab + 1);
    paths.push(path);
    if (added === "-" && removed === "-") {
      binaryFileCount += 1;
      files.push({ additions: null, binary: true, deletions: null, path });
      continue;
    }
    if (!/^\d+$/.test(added) || !/^\d+$/.test(removed)) {
      throw new Error("Git diff returned non-numeric numstat counts");
    }
    insertions += Number(added);
    deletions += Number(removed);
    files.push({
      additions: Number(added),
      binary: false,
      deletions: Number(removed),
      path
    });
  }
  return {
    binary_file_count: binaryFileCount,
    changed_file_count: records.length,
    deletions,
    files: files.sort((left, right) => compareText(left.path, right.path)),
    insertions,
    paths: sortedUnique(paths)
  };
}

export function workingTreeFileSize(repositoryRoot: string, gitPath: string): number | null {
  const path = resolve(repositoryRoot, gitPath);
  if (path === repositoryRoot || !path.startsWith(`${repositoryRoot}${sep}`)) {
    throw new Error("Git changed path escapes repository root");
  }
  try {
    const stat = lstatSync(path);
    return stat.isFile() || stat.isSymbolicLink() ? stat.size : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function nulFields(output: Buffer): string[] {
  if (output.length === 0) return [];
  if (output[output.length - 1] !== 0) throw new Error("Git returned unterminated zero-delimited output");
  return output.subarray(0, -1).toString("utf8").split("\0");
}

export function gitSnapshotSummary(
  headRevision: string | null,
  headRef: string | null,
  dirty: boolean,
  baseRevision: string | null,
  scoped: boolean
): string {
  const head = headRevision ? headRevision.slice(0, 12) : `unborn ${headRef ?? "HEAD"}`;
  const revision = headRevision && baseRevision && headRevision !== baseRevision ? "; revision differs from base" : "";
  return `Git ${scoped ? "selected-path " : ""}snapshot collected at ${head}; ` +
    `working tree ${dirty ? "dirty" : "clean"}${revision}`;
}

export function cleanOutput(output: Buffer, label: string): string {
  return cleanRequiredText(output.toString("utf8"), label);
}

function cleanRequiredText(value: string, label: string): string {
  const text = value.trim();
  if (text === "") throw new Error(`${label} is required`);
  return text;
}

export function normalizedTimestamp(value: string, label: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`${label} must be an ISO timestamp`);
  const normalized = new Date(time).toISOString();
  if (normalized !== value) throw new Error(`${label} must use canonical ISO format`);
  return normalized;
}

export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

export function normalizedPathspecs(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  const paths = values.map((value) => {
    if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0")) {
      throw new Error("Git pathspec must be a non-empty path up to 4096 characters");
    }
    if (isAbsolute(value) || value.includes("\\")) throw new Error("Git pathspec must be a repository-relative POSIX path");
    const segments = value.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error("Git pathspec cannot contain empty, dot, or parent segments");
    }
    return value;
  });
  const unique = sortedUnique(paths);
  if (unique.length !== paths.length) throw new Error("Git pathspecs must be unique");
  return unique;
}

function compareText(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

export function uniqueArtifactRefs(values: readonly EvidenceArtifactRef[]): EvidenceArtifactRef[] {
  const refs = new Set<string>();
  return values.filter((artifact) => {
    if (refs.has(artifact.ref)) return false;
    refs.add(artifact.ref);
    return true;
  }).map((artifact) => ({ ...artifact }));
}
