import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { DomainActor } from "../../xuanwu/coreDomainContracts.ts";
import { createLocalGitAdapter } from "../git/adapter.ts";
import {
  EVIDENCE_SCHEMA_VERSION,
  redactEvidenceRecord,
  redactEvidenceText,
  validateEvidence,
  type EvidenceArtifactRef,
  type EvidenceID,
  type EvidenceRecord,
  type RunAttemptID,
  type RunID,
  type WorkID
} from "./contracts.ts";

export const GIT_UNTRACKED_POLICIES = ["include_all", "exclude"] as const;
export type GitUntrackedPolicy = typeof GIT_UNTRACKED_POLICIES[number];

export type GitEvidenceContext = {
  attempt_id?: RunAttemptID;
  audit_event_ref: string;
  collected_at?: string;
  evidence_id: EvidenceID;
  producer: DomainActor;
  run_id?: RunID;
  source_ref: string;
  work_id: WorkID;
};

export type CollectGitEvidenceInput = {
  artifact_refs?: readonly EvidenceArtifactRef[];
  base_revision?: string;
  context: GitEvidenceContext;
  pathspecs?: readonly string[];
  repository_path: string;
  untracked_policy?: GitUntrackedPolicy;
};

export type GitSnapshotArtifactWrite = {
  audit_event_ref: string;
  bytes: number;
  content: string;
  evidence_id: EvidenceID;
  sha256: string;
  source_ref: string;
};

export interface GitEvidenceArtifactStore {
  writeGitSnapshot(input: GitSnapshotArtifactWrite): Promise<EvidenceArtifactRef> | EvidenceArtifactRef;
}

export interface GitEvidenceCollector {
  collect(input: CollectGitEvidenceInput): Promise<EvidenceRecord>;
}

export type GitEvidenceCollectorOptions = {
  artifact_store?: GitEvidenceArtifactStore;
  git_binary?: string;
  max_git_output_bytes?: number;
};

type GitStatusSummary = {
  conflict_count: number;
  dirty: boolean;
  paths: string[];
  staged_change_count: number;
  tracked_dirty: boolean;
  unstaged_change_count: number;
  untracked_count: number | null;
};

type GitDiffSummary = {
  binary_file_count: number;
  changed_file_count: number;
  deletions: number;
  files: GitChangedFileDiff[];
  insertions: number;
  paths: string[];
};

type GitChangedFileDiff = {
  additions: number | null;
  binary: boolean;
  deletions: number | null;
  path: string;
};

export type GitChangedFileDetail = {
  additions: number | null;
  binary: boolean | null;
  deletions: number | null;
  path: string;
  size_bytes: number | null;
};

export type GitSnapshotManifest = {
  base_revision: string | null;
  changed_files: GitChangedFileDetail[];
  changed_paths: string[];
  diff_stats: Omit<GitDiffSummary, "files" | "paths">;
  head_ref: string | null;
  head_revision: string | null;
  ignored_policy: "exclude";
  schema_version: 2;
  status: Omit<GitStatusSummary, "paths">;
  untracked_policy: GitUntrackedPolicy;
  working_tree_paths: string[];
};

const MAX_FACT_TEXT_BYTES = 8 * 1024;
const GIT_ARTIFACT_ROOT = "artifacts/evidence-git-snapshot";
const OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export function createGitEvidenceCollector(options: GitEvidenceCollectorOptions = {}): GitEvidenceCollector {
  const gitAdapter = createLocalGitAdapter({
    git_binary: options.git_binary,
    max_output_bytes: options.max_git_output_bytes
  });

  return {
    async collect(input) {
      validateInput(input);
      const repositoryRoot = repositoryRootPath(input.repository_path);
      const pathspecs = normalizedPathspecs(input.pathspecs);
      const runGit = (args: readonly string[], allowedExitCodes: readonly number[] = [0]) =>
        gitAdapter.run({ args, allowed_exit_codes: allowedExitCodes, repository_path: repositoryRoot });

      const topLevel = await runGit(["rev-parse", "--show-toplevel"]);
      if (realpathSync(cleanOutput(topLevel.stdout, "Git repository root")) !== repositoryRoot) {
        throw new Error("repository_path must point to the Git working tree root");
      }

      const headResult = await runGit(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], [0, 1, 128]);
      const headRevision = headResult.code === 0
        ? normalizedObjectID(cleanOutput(headResult.stdout, "Git HEAD revision"), "Git HEAD revision")
        : null;
      const headRefResult = await runGit(["symbolic-ref", "--quiet", "HEAD"], [0, 1]);
      const headRef = headRefResult.code === 0 ? cleanOutput(headRefResult.stdout, "Git HEAD ref") : null;
      const baseRevision = normalizedBaseRevision(input.base_revision, headRevision);
      if (baseRevision) await runGit(["cat-file", "-e", `${baseRevision}^{commit}`]);

      const untrackedPolicy = input.untracked_policy ?? "include_all";
      const statusResult = await runGit([
        "status",
        "--porcelain=v1",
        "-z",
        `--untracked-files=${untrackedPolicy === "include_all" ? "all" : "no"}`,
        "--ignored=no",
        "--",
        ...pathspecs
      ]);
      const status = parseGitStatus(statusResult.stdout, untrackedPolicy);
      const diff = parseGitNumstat((await runGit(diffArguments(baseRevision, pathspecs))).stdout);
      const changedPaths = sortedUnique([...status.paths, ...diff.paths]);
      const diffFiles = new Map(diff.files.map((file) => [file.path, file]));
      const changedFiles: GitChangedFileDetail[] = changedPaths.map((path) => {
        const diffFile = diffFiles.get(path);
        return {
          additions: diffFile?.additions ?? null,
          binary: diffFile?.binary ?? null,
          deletions: diffFile?.deletions ?? null,
          path,
          size_bytes: workingTreeFileSize(repositoryRoot, path)
        };
      });
      const manifest: GitSnapshotManifest = {
        schema_version: 2,
        head_revision: headRevision,
        head_ref: headRef,
        base_revision: baseRevision,
        status: {
          dirty: status.dirty,
          tracked_dirty: status.tracked_dirty,
          staged_change_count: status.staged_change_count,
          unstaged_change_count: status.unstaged_change_count,
          conflict_count: status.conflict_count,
          untracked_count: status.untracked_count
        },
        working_tree_paths: status.paths,
        changed_files: changedFiles,
        changed_paths: changedPaths,
        diff_stats: {
          changed_file_count: diff.changed_file_count,
          insertions: diff.insertions,
          deletions: diff.deletions,
          binary_file_count: diff.binary_file_count
        },
        untracked_policy: untrackedPolicy,
        ignored_policy: "exclude"
      };
      const canonicalManifest = `${JSON.stringify(manifest)}\n`;
      const snapshotSha256 = createHash("sha256").update(canonicalManifest).digest("hex");
      const pathspecSha256 = createHash("sha256").update(`${JSON.stringify(pathspecs)}\n`).digest("hex");
      const changedFilesJSON = JSON.stringify(changedFiles);
      const changedPathsJSON = JSON.stringify(changedPaths);
      const workingTreePathsJSON = JSON.stringify(status.paths);
      const requiresArtifact = Buffer.byteLength(changedFilesJSON) > MAX_FACT_TEXT_BYTES ||
        Buffer.byteLength(changedPathsJSON) > MAX_FACT_TEXT_BYTES ||
        Buffer.byteLength(workingTreePathsJSON) > MAX_FACT_TEXT_BYTES;
      const artifactRefs = uniqueArtifactRefs(input.artifact_refs ?? []);
      if (requiresArtifact) {
        if (!options.artifact_store) {
          throw new Error("Git changed paths exceed the inline Evidence limit but no artifact store was provided");
        }
        const safeManifest = redactEvidenceText(canonicalManifest);
        const bytes = Buffer.from(safeManifest);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const artifact = await options.artifact_store.writeGitSnapshot({
          audit_event_ref: input.context.audit_event_ref,
          bytes: bytes.byteLength,
          content: safeManifest,
          evidence_id: input.context.evidence_id,
          sha256,
          source_ref: input.context.source_ref
        });
        if (artifact.sha256 !== sha256) throw new Error("Git snapshot artifact checksum does not match the collected manifest");
        artifactRefs.push(artifact);
      }

      const observedAt = normalizedTimestamp(input.context.collected_at ?? new Date().toISOString(), "Evidence collected_at");
      const evidence: EvidenceRecord = {
        schema_version: EVIDENCE_SCHEMA_VERSION,
        id: input.context.evidence_id,
        work_id: input.context.work_id,
        ...(input.context.run_id ? { run_id: input.context.run_id } : {}),
        ...(input.context.attempt_id ? { attempt_id: input.context.attempt_id } : {}),
        revision: 0,
        kind: "git",
        status: "passed",
        created_at: observedAt,
        observed_at: observedAt,
        updated_at: observedAt,
        completed_at: observedAt,
        decisive_output: {
          summary: gitSnapshotSummary(headRevision, headRef, status.dirty, baseRevision, pathspecs.length > 0),
          facts: {
            base_revision: baseRevision,
            binary_file_count: diff.binary_file_count,
            changed_file_details_json: requiresArtifact ? null : changedFilesJSON,
            changed_path_count: changedPaths.length,
            changed_paths_inline: !requiresArtifact,
            changed_paths_json: requiresArtifact ? null : changedPathsJSON,
            conflict_count: status.conflict_count,
            deletions: diff.deletions,
            diff_changed_file_count: diff.changed_file_count,
            diff_scope: baseRevision ? "base_to_worktree_tracked" : "index_to_unborn",
            head_ref: headRef,
            head_revision: headRevision,
            ignored_policy: "exclude",
            insertions: diff.insertions,
            is_detached: headRevision !== null && headRef === null,
            is_unborn: headRevision === null,
            pathspec_count: pathspecs.length,
            pathspec_scope: pathspecs.length > 0 ? "selected_paths" : "repository",
            pathspec_sha256: pathspecSha256,
            revision_changed_from_base: Boolean(headRevision && baseRevision && headRevision !== baseRevision),
            snapshot_sha256: snapshotSha256,
            staged_change_count: status.staged_change_count,
            tracked_dirty: status.tracked_dirty,
            unstaged_change_count: status.unstaged_change_count,
            untracked_count: status.untracked_count,
            untracked_policy: untrackedPolicy,
            working_tree_dirty: status.dirty,
            working_tree_path_count: status.paths.length,
            working_tree_paths_json: requiresArtifact ? null : workingTreePathsJSON
          }
        },
        artifact_refs: uniqueArtifactRefs(artifactRefs),
        provenance: {
          assertion_origin: "system_observation",
          source_kind: "git_repository",
          source_ref: input.context.source_ref,
          audit_event_ref: input.context.audit_event_ref,
          producer: input.context.producer
        },
        redaction: {
          status: "not_required",
          policy_ref: "evidence-redaction:v1",
          redacted_paths: []
        }
      };
      const redacted = redactEvidenceRecord(evidence, "evidence-redaction:v1");
      const validation = validateEvidence(redacted);
      if (!validation.ok) throw new Error(`Git collector produced invalid Evidence: ${validation.errors.join("; ")}`);
      return redacted;
    }
  };
}

export class FileSystemGitEvidenceArtifactStore implements GitEvidenceArtifactStore {
  constructor(private readonly stateDir: string) {
    if (stateDir.trim() === "") throw new Error("Git Evidence artifact state directory is required");
  }

  writeGitSnapshot(input: GitSnapshotArtifactWrite): EvidenceArtifactRef {
    const bytes = Buffer.from(input.content);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== input.bytes || sha256 !== input.sha256) {
      throw new Error("Git snapshot artifact content does not match its declared digest");
    }
    const ref = `${GIT_ARTIFACT_ROOT}/${sha256.slice(0, 2)}/${sha256}.json`;
    const path = this.artifactPath(ref);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
        renameSync(temporary, path);
      } finally {
        rmSync(temporary, { force: true });
      }
    }
    return {
      kind: "report",
      ref,
      label: "Git Evidence snapshot manifest",
      media_type: "application/json",
      sha256
    };
  }

  private artifactPath(ref: string): string {
    if (!new RegExp(`^${GIT_ARTIFACT_ROOT}/[a-f0-9]{2}/[a-f0-9]{64}\\.json$`).test(ref)) {
      throw new Error("invalid Git Evidence artifact ref");
    }
    const root = resolve(this.stateDir, GIT_ARTIFACT_ROOT);
    const path = resolve(this.stateDir, ref);
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      throw new Error("Git Evidence artifact ref escapes state directory");
    }
    return path;
  }
}

function validateInput(input: CollectGitEvidenceInput): void {
  cleanRequiredText(input.repository_path, "Git repository path");
  if (input.untracked_policy && !GIT_UNTRACKED_POLICIES.includes(input.untracked_policy)) {
    throw new Error("unsupported Git untracked policy");
  }
  if (input.base_revision !== undefined) normalizedObjectID(input.base_revision, "Git base revision");
  normalizedPathspecs(input.pathspecs);
}

function repositoryRootPath(value: string): string {
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

function normalizedBaseRevision(value: string | undefined, headRevision: string | null): string | null {
  return value === undefined ? headRevision : normalizedObjectID(value, "Git base revision");
}

function normalizedObjectID(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!OBJECT_ID_PATTERN.test(normalized)) throw new Error(`${label} must be a full 40- or 64-character object id`);
  return normalized;
}

function diffArguments(baseRevision: string | null, pathspecs: readonly string[]): string[] {
  const options = ["--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", "-z"];
  return baseRevision
    ? ["diff", ...options, baseRevision, "--", ...pathspecs]
    : ["diff", "--cached", ...options, "--", ...pathspecs];
}

function parseGitStatus(output: Buffer, policy: GitUntrackedPolicy): GitStatusSummary {
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

function parseGitNumstat(output: Buffer): GitDiffSummary {
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

function workingTreeFileSize(repositoryRoot: string, gitPath: string): number | null {
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

function gitSnapshotSummary(
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

function cleanOutput(output: Buffer, label: string): string {
  return cleanRequiredText(output.toString("utf8"), label);
}

function cleanRequiredText(value: string, label: string): string {
  const text = value.trim();
  if (text === "") throw new Error(`${label} is required`);
  return text;
}

function normalizedTimestamp(value: string, label: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`${label} must be an ISO timestamp`);
  const normalized = new Date(time).toISOString();
  if (normalized !== value) throw new Error(`${label} must use canonical ISO format`);
  return normalized;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function normalizedPathspecs(values: readonly string[] | undefined): string[] {
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

function uniqueArtifactRefs(values: readonly EvidenceArtifactRef[]): EvidenceArtifactRef[] {
  const refs = new Set<string>();
  return values.filter((artifact) => {
    if (refs.has(artifact.ref)) return false;
    refs.add(artifact.ref);
    return true;
  }).map((artifact) => ({ ...artifact }));
}
