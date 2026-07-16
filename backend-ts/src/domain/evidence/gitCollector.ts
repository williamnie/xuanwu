import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { DomainActor } from "../../xuanwu/coreDomainContracts.ts";
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

type GitCommandResult = {
  code: number;
  stderr: Buffer;
  stdout: Buffer;
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
  insertions: number;
  paths: string[];
};

type GitSnapshotManifest = {
  base_revision: string | null;
  changed_paths: string[];
  diff_stats: Omit<GitDiffSummary, "paths">;
  head_ref: string | null;
  head_revision: string | null;
  ignored_policy: "exclude";
  schema_version: 1;
  status: Omit<GitStatusSummary, "paths">;
  untracked_policy: GitUntrackedPolicy;
  working_tree_paths: string[];
};

const DEFAULT_MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_FACT_TEXT_BYTES = 8 * 1024;
const GIT_ARTIFACT_ROOT = "artifacts/evidence-git-snapshot";
const OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export function createGitEvidenceCollector(options: GitEvidenceCollectorOptions = {}): GitEvidenceCollector {
  const gitBinary = cleanRequiredText(options.git_binary ?? "git", "git binary");
  const outputLimit = boundedPositiveInteger(
    options.max_git_output_bytes,
    DEFAULT_MAX_GIT_OUTPUT_BYTES,
    128 * 1024 * 1024
  );

  return {
    async collect(input) {
      validateInput(input);
      const repositoryRoot = repositoryRootPath(input.repository_path);
      const runGit = (args: readonly string[], allowedExitCodes: readonly number[] = [0]) =>
        executeGit(gitBinary, repositoryRoot, args, outputLimit, allowedExitCodes);

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
        "--"
      ]);
      const status = parseGitStatus(statusResult.stdout, untrackedPolicy);
      const diff = parseGitNumstat((await runGit(diffArguments(baseRevision))).stdout);
      const changedPaths = sortedUnique([...status.paths, ...diff.paths]);
      const manifest: GitSnapshotManifest = {
        schema_version: 1,
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
      const changedPathsJSON = JSON.stringify(changedPaths);
      const workingTreePathsJSON = JSON.stringify(status.paths);
      const requiresArtifact = Buffer.byteLength(changedPathsJSON) > MAX_FACT_TEXT_BYTES ||
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
          summary: gitSnapshotSummary(headRevision, headRef, status.dirty, baseRevision),
          facts: {
            base_revision: baseRevision,
            binary_file_count: diff.binary_file_count,
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
      label: "Git Evidence changed-path manifest",
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

function diffArguments(baseRevision: string | null): string[] {
  const options = ["--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", "-z"];
  return baseRevision
    ? ["diff", ...options, baseRevision, "--"]
    : ["diff", "--cached", ...options, "--"];
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
    paths.push(record.slice(secondTab + 1));
    if (added === "-" && removed === "-") {
      binaryFileCount += 1;
      continue;
    }
    if (!/^\d+$/.test(added) || !/^\d+$/.test(removed)) {
      throw new Error("Git diff returned non-numeric numstat counts");
    }
    insertions += Number(added);
    deletions += Number(removed);
  }
  return {
    binary_file_count: binaryFileCount,
    changed_file_count: records.length,
    deletions,
    insertions,
    paths: sortedUnique(paths)
  };
}

function nulFields(output: Buffer): string[] {
  if (output.length === 0) return [];
  if (output[output.length - 1] !== 0) throw new Error("Git returned unterminated zero-delimited output");
  return output.subarray(0, -1).toString("utf8").split("\0");
}

async function executeGit(
  binary: string,
  repositoryRoot: string,
  args: readonly string[],
  outputLimit: number,
  allowedExitCodes: readonly number[]
): Promise<GitCommandResult> {
  const result = await spawnAndCapture(binary, [
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null",
    "-c", "diff.external=",
    "-C", repositoryRoot,
    ...args
  ], safeGitEnvironment(repositoryRoot), outputLimit);
  if (!allowedExitCodes.includes(result.code)) {
    const detail = redactEvidenceText(result.stderr.toString("utf8").trim()).slice(0, 1024);
    throw new Error(`git ${args[0] ?? "command"} failed with exit ${result.code}${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function spawnAndCapture(
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  outputLimit: number
): Promise<GitCommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(binary, [...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    const capture = (target: Buffer[]) => (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > outputLimit) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      target.push(value);
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (overflow) return rejectPromise(new Error(`Git output exceeded ${outputLimit} bytes`));
      if (code === null) return rejectPromise(new Error("Git process ended without an exit code"));
      resolvePromise({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

function safeGitEnvironment(repositoryRoot: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    GIT_CEILING_DIRECTORIES: dirname(repositoryRoot),
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    HOME: repositoryRoot,
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    PATH: process.env.PATH ?? ""
  };
  if (process.platform === "win32") {
    environment.ComSpec = process.env.ComSpec;
    environment.SystemRoot = process.env.SystemRoot;
  }
  return environment;
}

function gitSnapshotSummary(
  headRevision: string | null,
  headRef: string | null,
  dirty: boolean,
  baseRevision: string | null
): string {
  const head = headRevision ? headRevision.slice(0, 12) : `unborn ${headRef ?? "HEAD"}`;
  const revision = headRevision && baseRevision && headRevision !== baseRevision ? "; revision differs from base" : "";
  return `Git snapshot collected at ${head}; working tree ${dirty ? "dirty" : "clean"}${revision}`;
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

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`collector byte limit must be between 1 and ${maximum}`);
  }
  return value;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

function uniqueArtifactRefs(values: readonly EvidenceArtifactRef[]): EvidenceArtifactRef[] {
  const refs = new Set<string>();
  return values.filter((artifact) => {
    if (refs.has(artifact.ref)) return false;
    refs.add(artifact.ref);
    return true;
  }).map((artifact) => ({ ...artifact }));
}
