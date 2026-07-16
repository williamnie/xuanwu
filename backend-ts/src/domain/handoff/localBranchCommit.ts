import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeDomainID,
  parseDomainID,
  type DomainActor,
  type EvidenceStatus,
  type RunID,
  type WorkID
} from "../../xuanwu/coreDomainContracts.ts";
import {
  createGitEvidenceCollector,
  type GitEvidenceCollector,
  type GitEvidenceContext
} from "../evidence/gitCollector.ts";
import { redactEvidenceText, type EvidenceID, type EvidenceRecord } from "../evidence/contracts.ts";
import { createLocalGitAdapter, type LocalGitAdapter, type LocalGitIdentity } from "../git/adapter.ts";
import { validateHandoff, type HandoffRecord } from "./contracts.ts";
import { buildHandoffDiffSummary, type HandoffDiffSummary } from "./diffSummary.ts";

export const LOCAL_GIT_HANDOFF_ACTION = "handoff.commit" as const;
export const LOCAL_GIT_HANDOFF_POLICY_VERSION = 1 as const;

export type LocalGitHandoffProjectPolicy = {
  allowed_actions: readonly string[];
  allowed_base_branches: readonly string[];
  branch_prefix: string;
  branch_reuse: "never" | "same_baseline";
  commit_identity: LocalGitIdentity;
  commit_subject_prefixes: readonly string[];
  max_commit_subject_length: number;
  policy_ref: string;
  project_id: string;
  version: typeof LOCAL_GIT_HANDOFF_POLICY_VERSION;
};

export type ResolveLocalGitHandoffProjectPolicyInput = Omit<
  LocalGitHandoffProjectPolicy,
  "allowed_actions" | "version"
> & {
  allowed_actions_json: string;
};

export type LocalGitHandoffAuditEvent = {
  actor: DomainActor;
  correlation_id: string;
  event_id: string;
  event_type: "handoff.local_git.intent.v1" | "handoff.local_git.outcome.v1" | "handoff.local_git.rollback.v1";
  facts: Record<string, boolean | number | string | null | string[]>;
  occurred_at: string;
  policy_ref: string;
  project_id: string;
  repository_ref: string;
  work_id: WorkID;
};

export interface LocalGitHandoffAuditSink {
  record(event: LocalGitHandoffAuditEvent): Promise<void> | void;
}

export interface LocalGitHandoffProjectPolicyReader {
  read(projectID: string): LocalGitHandoffProjectPolicy | Promise<LocalGitHandoffProjectPolicy>;
}

export type LocalGitHandoffEvidenceInput = Omit<
  GitEvidenceContext,
  "audit_event_ref" | "collected_at" | "source_ref" | "work_id"
>;

export type LocalBranchCommitHandoffRequest = {
  audit: {
    actor: DomainActor;
    correlation_id: string;
    intent_event_id: string;
    outcome_event_id: string;
    rollback_event_id: string;
  };
  commit_message: string;
  git_evidence: LocalGitHandoffEvidenceInput;
  linked_evidence: readonly { id: EvidenceID; status: EvidenceStatus; work_id: WorkID }[];
  project_id: string;
  repository_path: string;
  repository_ref: string;
  run_ids: readonly RunID[];
  runs: readonly { id: RunID; work_id: WorkID }[];
  selected_paths: readonly string[];
  work_id: WorkID;
  work_title: string;
};

export type LocalBranchCommitHandoffResult = {
  audit_event_refs: string[];
  branch_created: boolean;
  branch_ref: string;
  commit_revision: string;
  diff_summary: HandoffDiffSummary;
  git_evidence: EvidenceRecord;
  handoff: HandoffRecord;
};

export type LocalBranchCommitHandoffServiceOptions = {
  audit_sink: LocalGitHandoffAuditSink;
  git_adapter?: LocalGitAdapter;
  git_evidence_collector?: GitEvidenceCollector;
  now?: () => string;
  project_policy_reader: LocalGitHandoffProjectPolicyReader;
};

type RepositoryPreflight = {
  active_branch: string;
  baseline_revision: string;
  dirty_baseline_sha256: string;
  dirty_path_count: number;
  staged_change_count: number;
  target_branch: string;
  target_existed: boolean;
  target_ref: string;
};

export function resolveLocalGitHandoffProjectPolicy(
  input: ResolveLocalGitHandoffProjectPolicyInput
): LocalGitHandoffProjectPolicy {
  let allowedActions: unknown;
  try {
    allowedActions = JSON.parse(input.allowed_actions_json);
  } catch {
    throw new Error("project allowed_actions_json is invalid JSON");
  }
  if (!Array.isArray(allowedActions) || allowedActions.some((action) => typeof action !== "string")) {
    throw new Error("project allowed_actions_json must be a string array");
  }
  return normalizePolicy({
    ...input,
    allowed_actions: allowedActions,
    version: LOCAL_GIT_HANDOFF_POLICY_VERSION
  });
}

export function createLocalBranchCommitHandoffService(options: LocalBranchCommitHandoffServiceOptions): {
  execute(request: LocalBranchCommitHandoffRequest): Promise<LocalBranchCommitHandoffResult>;
} {
  const git = options.git_adapter ?? createLocalGitAdapter();
  const evidenceCollector = options.git_evidence_collector ?? createGitEvidenceCollector();
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async execute(request) {
      const projectID = requiredText(request.project_id, "project id", 128);
      const policy = normalizePolicy(await options.project_policy_reader.read(projectID));
      validateRequest(request, policy);
      const selectedPaths = normalizedSelectedPaths(request.selected_paths);
      const commitMessage = normalizedCommitMessage(request.commit_message, policy);
      const occurredAt = canonicalTimestamp(now());
      const repositoryRoot = await repositoryRootPath(git, request.repository_path);
      const preflight = await inspectRepository(git, repositoryRoot, request, policy, selectedPaths);
      await options.audit_sink.record(auditEvent(request, policy, occurredAt, "handoff.local_git.intent.v1", {
        active_branch: preflight.active_branch,
        baseline_revision: preflight.baseline_revision,
        dirty_baseline_sha256: preflight.dirty_baseline_sha256,
        dirty_path_count: preflight.dirty_path_count,
        evidence_id: request.git_evidence.evidence_id,
        selected_scope_sha256: createHash("sha256").update(`${JSON.stringify(selectedPaths)}\n`).digest("hex"),
        selected_paths: selectedPaths,
        staged_change_count: preflight.staged_change_count,
        target_branch: preflight.target_branch,
        target_existed: preflight.target_existed
      }));

      let temporaryDirectory: string | null = null;
      let commitRevision = "";
      let refUpdated = false;
      try {
        const gitEvidence = await evidenceCollector.collect({
          base_revision: preflight.baseline_revision,
          context: {
            ...request.git_evidence,
            audit_event_ref: request.audit.intent_event_id,
            collected_at: occurredAt,
            source_ref: request.repository_ref,
            work_id: request.work_id
          },
          pathspecs: selectedPaths,
          repository_path: repositoryRoot,
          untracked_policy: "include_all"
        });
        const diffSummary = buildHandoffDiffSummary({ git_evidence: gitEvidence });
        validateSelectedSummary(selectedPaths, diffSummary);
        temporaryDirectory = await mkdtemp(join(tmpdir(), "xw-local-handoff-index-"));
        const temporaryIndex = join(temporaryDirectory, "index");
        await runGit(git, repositoryRoot, ["read-tree", preflight.baseline_revision], { indexFile: temporaryIndex });
        await runGit(git, repositoryRoot, ["add", "-A", "--", ...selectedPaths], { indexFile: temporaryIndex });
        const stagedPaths = nulFields((await runGit(git, repositoryRoot, [
          "diff", "--cached", "--name-only", "--no-renames", "-z", preflight.baseline_revision, "--", ...selectedPaths
        ], { indexFile: temporaryIndex })).stdout);
        assertSamePaths(stagedPaths, diffSummary.changed_files, "staged paths changed after Git Evidence collection");
        const treeRevision = objectID((await runGit(git, repositoryRoot, ["write-tree"], {
          indexFile: temporaryIndex
        })).stdout, "Git tree revision");
        commitRevision = objectID((await runGit(git, repositoryRoot, [
          "commit-tree", treeRevision, "-p", preflight.baseline_revision, "-m", commitMessage
        ], { identity: policy.commit_identity })).stdout, "Git commit revision");
        const committedTree = objectID((await runGit(git, repositoryRoot, ["rev-parse", `${commitRevision}^{tree}`])).stdout,
          "committed Git tree revision");
        if (committedTree !== treeRevision) throw new Error("Git commit tree does not match the scoped staging tree");
        const freshness = await runGit(git, repositoryRoot, [
          "diff", "--quiet", "--no-ext-diff", "--no-textconv", commitRevision, "--", ...selectedPaths
        ], { allowedExitCodes: [0, 1] });
        if (freshness.code !== 0) throw new Error("selected paths changed while the local Handoff commit was prepared");
        const currentHead = objectID((await runGit(git, repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout,
          "current Git HEAD revision");
        if (currentHead !== preflight.baseline_revision) throw new Error("Git HEAD changed after local Handoff preflight");

        const handoff = buildHandoff(request, policy, preflight, diffSummary, gitEvidence, commitRevision, occurredAt);
        const validation = validateHandoff(handoff, {
          evidence: [...request.linked_evidence, {
            id: gitEvidence.id,
            status: gitEvidence.status,
            work_id: gitEvidence.work_id
          }],
          runs: [...request.runs]
        });
        if (!validation.ok) throw new Error(`local Handoff validation failed: ${validation.errors.join("; ")}`);

        await updateTargetRef(git, repositoryRoot, preflight, commitRevision, request.audit.outcome_event_id);
        refUpdated = true;
        await options.audit_sink.record(auditEvent(request, policy, occurredAt, "handoff.local_git.outcome.v1", {
          baseline_revision: preflight.baseline_revision,
          branch_created: !preflight.target_existed,
          branch_ref: preflight.target_ref,
          commit_revision: commitRevision,
          handoff_id: handoff.id,
          status: "succeeded",
          tree_verified: true
        }));
        return {
          audit_event_refs: [request.audit.intent_event_id, request.audit.outcome_event_id],
          branch_created: !preflight.target_existed,
          branch_ref: preflight.target_ref,
          commit_revision: commitRevision,
          diff_summary: diffSummary,
          git_evidence: gitEvidence,
          handoff
        };
      } catch (error) {
        const cleanError = redactedError(error);
        if (refUpdated) {
          const rollbackError = await rollbackTargetRef(git, repositoryRoot, preflight, commitRevision);
          await recordBestEffort(options.audit_sink, auditEvent(
            request,
            policy,
            canonicalTimestamp(now()),
            "handoff.local_git.rollback.v1",
            {
              branch_ref: preflight.target_ref,
              failed_commit_revision: commitRevision,
              reason: cleanError,
              rollback_error: rollbackError,
              rollback_status: rollbackError ? "failed" : "succeeded"
            }
          ));
          if (rollbackError) throw new Error(`${cleanError}; local Git rollback failed: ${rollbackError}`);
        } else {
          await recordBestEffort(options.audit_sink, auditEvent(
            request,
            policy,
            canonicalTimestamp(now()),
            "handoff.local_git.outcome.v1",
            {
              baseline_revision: preflight.baseline_revision,
              branch_ref: preflight.target_ref,
              error: cleanError,
              status: "failed"
            }
          ));
        }
        throw new Error(cleanError);
      } finally {
        if (temporaryDirectory) await rm(temporaryDirectory, { force: true, recursive: true });
      }
    }
  };
}

function normalizePolicy(input: LocalGitHandoffProjectPolicy): LocalGitHandoffProjectPolicy {
  if (input.version !== LOCAL_GIT_HANDOFF_POLICY_VERSION) throw new Error("unsupported local Git Handoff policy version");
  const projectID = requiredText(input.project_id, "project policy project_id", 128);
  const policyRef = requiredText(input.policy_ref, "project policy ref", 4096);
  const branchPrefix = requiredText(input.branch_prefix, "branch prefix", 128);
  if (!/^[a-z0-9][a-z0-9._/-]*[/-]$/.test(branchPrefix) || invalidRefText(branchPrefix)) {
    throw new Error("branch prefix must be a safe lowercase Git namespace ending in / or -");
  }
  const maxSubjectLength = input.max_commit_subject_length;
  if (!Number.isSafeInteger(maxSubjectLength) || maxSubjectLength < 20 || maxSubjectLength > 240) {
    throw new Error("max commit subject length must be between 20 and 240");
  }
  return {
    allowed_actions: uniqueText(input.allowed_actions, "allowed actions", 128),
    allowed_base_branches: uniqueText(input.allowed_base_branches, "allowed base branches", 240),
    branch_prefix: branchPrefix,
    branch_reuse: normalizedBranchReuse(input.branch_reuse),
    commit_identity: normalizedIdentity(input.commit_identity),
    commit_subject_prefixes: uniqueText(input.commit_subject_prefixes, "commit subject prefixes", 80),
    max_commit_subject_length: maxSubjectLength,
    policy_ref: policyRef,
    project_id: projectID,
    version: LOCAL_GIT_HANDOFF_POLICY_VERSION
  };
}

function validateRequest(request: LocalBranchCommitHandoffRequest, policy: LocalGitHandoffProjectPolicy): void {
  if (policy.project_id !== requiredText(request.project_id, "project id", 128)) {
    throw new Error("local Git Handoff policy belongs to another project");
  }
  if (!policy.allowed_actions.includes(LOCAL_GIT_HANDOFF_ACTION)) {
    throw new Error(`project policy does not allow ${LOCAL_GIT_HANDOFF_ACTION}`);
  }
  if (parseDomainID(request.work_id)?.kind !== "work") throw new Error("local Git Handoff requires a supported Work id");
  requiredText(request.work_title, "Work title", 4096);
  requiredText(request.repository_ref, "Git repository ref", 8192);
  if (request.git_evidence.run_id && !request.run_ids.includes(request.git_evidence.run_id)) {
    throw new Error("Git Evidence run_id must be linked by the Handoff");
  }
  if (new Set(request.run_ids).size !== request.run_ids.length) throw new Error("local Handoff run_ids must be unique");
  const runs = new Map(request.runs.map((run) => [run.id, run]));
  for (const runID of request.run_ids) {
    const run = runs.get(runID);
    if (!run) throw new Error(`${runID} is not present in local Handoff run context`);
    if (run.work_id !== request.work_id) throw new Error(`${runID} Run belongs to another Work`);
  }
  if (new Set(request.linked_evidence.map((item) => item.id)).size !== request.linked_evidence.length) {
    throw new Error("local Handoff linked Evidence ids must be unique");
  }
  for (const evidence of request.linked_evidence) {
    if (evidence.work_id !== request.work_id) throw new Error(`${evidence.id} Evidence belongs to another Work`);
    if (evidence.id === request.git_evidence.evidence_id) throw new Error("fresh Git Evidence id is already linked");
  }
  for (const value of [request.audit.correlation_id, request.audit.intent_event_id,
    request.audit.outcome_event_id, request.audit.rollback_event_id, request.audit.actor.id]) {
    requiredText(value, "local Git Handoff audit field", 4096);
  }
  if (new Set([request.audit.intent_event_id, request.audit.outcome_event_id, request.audit.rollback_event_id]).size !== 3) {
    throw new Error("local Git Handoff audit event ids must be unique");
  }
}

async function inspectRepository(
  git: LocalGitAdapter,
  repositoryRoot: string,
  request: LocalBranchCommitHandoffRequest,
  policy: LocalGitHandoffProjectPolicy,
  selectedPaths: readonly string[]
): Promise<RepositoryPreflight> {
  const baselineRevision = objectID((await runGit(git, repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout,
    "Git baseline revision");
  const activeRefResult = await runGit(git, repositoryRoot, ["symbolic-ref", "--quiet", "HEAD"], { allowedExitCodes: [0, 1] });
  if (activeRefResult.code !== 0) throw new Error("local Git Handoff requires an attached branch");
  const activeRef = cleanOutput(activeRefResult.stdout, "active Git branch ref");
  if (!activeRef.startsWith("refs/heads/")) throw new Error("active Git ref is not a local branch");
  const activeBranch = activeRef.slice("refs/heads/".length);
  if (policy.allowed_base_branches.length > 0 && !policy.allowed_base_branches.includes(activeBranch)) {
    throw new Error(`project policy does not allow base branch ${activeBranch}`);
  }
  const targetBranch = branchNameForWork(policy, request.work_id, request.work_title);
  await runGit(git, repositoryRoot, ["check-ref-format", "--branch", targetBranch]);
  const targetRef = `refs/heads/${targetBranch}`;
  if (targetRef === activeRef) {
    throw new Error("local Handoff target branch must not be checked out; use a distinct policy prefix or base branch");
  }
  const worktrees = (await runGit(git, repositoryRoot, ["worktree", "list", "--porcelain", "-z"])).stdout.toString("utf8");
  if (worktrees.split("\0").includes(`branch ${targetRef}`)) {
    throw new Error("local Handoff target branch is checked out in another worktree");
  }
  const targetResult = await runGit(git, repositoryRoot, ["rev-parse", "--verify", "--quiet", `${targetRef}^{commit}`], {
    allowedExitCodes: [0, 1, 128]
  });
  const targetExisted = targetResult.code === 0;
  if (targetExisted) {
    const targetRevision = objectID(targetResult.stdout, "existing Handoff branch revision");
    if (policy.branch_reuse !== "same_baseline") throw new Error(`project policy forbids reusing ${targetBranch}`);
    if (targetRevision !== baselineRevision) throw new Error("existing Handoff branch does not match the current baseline");
  }

  const status = await runGit(git, repositoryRoot, [
    "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=no", "--"
  ]);
  const parsedStatus = parseStatus(status.stdout);
  if (parsedStatus.conflict_count > 0) throw new Error("local Git Handoff refuses a conflicted working tree");
  if (!parsedStatus.paths.some((path) => selectedPaths.some((selected) => pathCoveredBy(path, selected)))) {
    throw new Error("selected paths do not contain a working tree change");
  }
  return {
    active_branch: activeBranch,
    baseline_revision: baselineRevision,
    dirty_baseline_sha256: createHash("sha256").update(status.stdout).digest("hex"),
    dirty_path_count: parsedStatus.paths.length,
    staged_change_count: parsedStatus.staged_change_count,
    target_branch: targetBranch,
    target_existed: targetExisted,
    target_ref: targetRef
  };
}

function buildHandoff(
  request: LocalBranchCommitHandoffRequest,
  policy: LocalGitHandoffProjectPolicy,
  preflight: RepositoryPreflight,
  summary: HandoffDiffSummary,
  gitEvidence: EvidenceRecord,
  commitRevision: string,
  occurredAt: string
): HandoffRecord {
  const work = parseDomainID(request.work_id)!;
  const evidenceIDs = [...new Set([...request.linked_evidence.map((item) => item.id), gitEvidence.id])];
  return {
    schema_version: 1,
    id: makeDomainID("handoff", "derived", `${work.local_id}@${commitRevision}`),
    work_id: request.work_id,
    run_ids: [...request.run_ids],
    evidence_ids: evidenceIDs,
    revision: 0,
    status: "ready",
    summary: summary.summary,
    created_at: occurredAt,
    updated_at: occurredAt,
    baseline_revision: preflight.baseline_revision,
    final_revision: commitRevision,
    review_ref: commitRevision,
    changed_files: summary.changed_files,
    delivery: {
      mode: "branch_commit",
      branch_ref: preflight.target_ref,
      commit_ref: commitRevision
    },
    delivery_actions: [{
      action: "commit",
      required: true,
      classification: "state_change",
      target: `${request.repository_ref}#${preflight.target_ref}`,
      gate: { authority: "deterministic_policy", policy_ref: policy.policy_ref },
      gate_decision: "allow",
      outcome: "succeeded",
      audit_event_ref: request.audit.outcome_event_id,
      before_ref: preflight.baseline_revision,
      after_ref: commitRevision,
      rollback_ref: request.audit.rollback_event_id
    }],
    risks: summary.risk_hints,
    rollback: {
      availability: "available",
      destructive: false,
      plan: preflight.target_existed
        ? `CAS restore ${preflight.target_ref} to ${preflight.baseline_revision}`
        : `CAS delete ${preflight.target_ref} if it still points to ${commitRevision}`,
      refs: [request.audit.rollback_event_id, preflight.target_ref]
    },
    review: { required: false, state: "not_requested", reviewer_refs: [] }
  };
}

async function updateTargetRef(
  git: LocalGitAdapter,
  repositoryRoot: string,
  preflight: RepositoryPreflight,
  commitRevision: string,
  reason: string
): Promise<void> {
  const expected = preflight.target_existed
    ? preflight.baseline_revision
    : "0".repeat(preflight.baseline_revision.length);
  await runGit(git, repositoryRoot, [
    "update-ref", "-m", reason, preflight.target_ref, commitRevision, expected
  ]);
}

async function rollbackTargetRef(
  git: LocalGitAdapter,
  repositoryRoot: string,
  preflight: RepositoryPreflight,
  commitRevision: string
): Promise<string | null> {
  try {
    if (preflight.target_existed) {
      await runGit(git, repositoryRoot, [
        "update-ref", "-m", "local Handoff rollback", preflight.target_ref,
        preflight.baseline_revision, commitRevision
      ]);
    } else {
      await runGit(git, repositoryRoot, [
        "update-ref", "-d", preflight.target_ref, commitRevision
      ]);
    }
    return null;
  } catch (error) {
    return redactedError(error);
  }
}

function auditEvent(
  request: LocalBranchCommitHandoffRequest,
  policy: LocalGitHandoffProjectPolicy,
  occurredAt: string,
  eventType: LocalGitHandoffAuditEvent["event_type"],
  facts: LocalGitHandoffAuditEvent["facts"]
): LocalGitHandoffAuditEvent {
  const eventID = eventType === "handoff.local_git.intent.v1" ? request.audit.intent_event_id
    : eventType === "handoff.local_git.outcome.v1" ? request.audit.outcome_event_id
    : request.audit.rollback_event_id;
  return {
    actor: request.audit.actor,
    correlation_id: request.audit.correlation_id,
    event_id: eventID,
    event_type: eventType,
    facts,
    occurred_at: occurredAt,
    policy_ref: policy.policy_ref,
    project_id: policy.project_id,
    repository_ref: request.repository_ref,
    work_id: request.work_id
  };
}

async function recordBestEffort(sink: LocalGitHandoffAuditSink, event: LocalGitHandoffAuditEvent): Promise<void> {
  try {
    await sink.record(event);
  } catch {
    // The caller receives the original operation failure. A failed audit write must never suppress rollback.
  }
}

async function repositoryRootPath(git: LocalGitAdapter, value: string): Promise<string> {
  let requested: string;
  try {
    requested = realpathSync(requiredText(value, "Git repository path", 8192));
  } catch {
    throw new Error("Git repository path does not exist");
  }
  const topLevel = realpathSync(cleanOutput((await runGit(git, requested, ["rev-parse", "--show-toplevel"])).stdout,
    "Git repository root"));
  if (requested !== topLevel) throw new Error("repository_path must point to the Git working tree root");
  return topLevel;
}

async function runGit(
  git: LocalGitAdapter,
  repositoryPath: string,
  args: readonly string[],
  options: { allowedExitCodes?: readonly number[]; identity?: LocalGitIdentity; indexFile?: string } = {}
) {
  return git.run({
    allowed_exit_codes: options.allowedExitCodes,
    args,
    identity: options.identity,
    index_file: options.indexFile,
    repository_path: repositoryPath
  });
}

function normalizedSelectedPaths(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 4096) {
    throw new Error("selected paths must contain between 1 and 4096 repository paths");
  }
  const paths = values.map((value) => {
    if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0") ||
      value.startsWith("/") || value.includes("\\")) {
      throw new Error("selected path must be a repository-relative POSIX path");
    }
    const segments = value.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error("selected path cannot contain empty, dot, or parent segments");
    }
    return value;
  }).sort(compareText);
  if (new Set(paths).size !== paths.length) throw new Error("selected paths must be unique");
  return paths;
}

function normalizedCommitMessage(value: string, policy: LocalGitHandoffProjectPolicy): string {
  if (typeof value !== "string" || value !== value.trim() || /[\r\n\0]/.test(value) || value.length === 0) {
    throw new Error("commit message must be a non-empty single-line subject without surrounding whitespace");
  }
  if (Buffer.byteLength(value, "utf8") > policy.max_commit_subject_length) {
    throw new Error("commit message exceeds the project policy length limit");
  }
  if (policy.commit_subject_prefixes.length > 0 &&
    !policy.commit_subject_prefixes.some((prefix) => value.startsWith(prefix))) {
    throw new Error("commit message does not match a project policy prefix");
  }
  return value;
}

function normalizedIdentity(value: LocalGitIdentity): LocalGitIdentity {
  const name = requiredText(value.name, "commit identity name", 256);
  const email = requiredText(value.email, "commit identity email", 320);
  if (/[\r\n\0]/.test(name) || /[\r\n\0]/.test(email) || !/^[^@\s]+@[^@\s]+$/.test(email)) {
    throw new Error("commit identity is invalid");
  }
  return { email, name };
}

function branchNameForWork(policy: LocalGitHandoffProjectPolicy, workID: WorkID, title: string): string {
  const work = parseDomainID(workID);
  if (!work) throw new Error("cannot derive branch name from Work id");
  const localID = slug(work.local_id, 48) || "work";
  const titleSlug = slug(title, 96);
  const suffix = titleSlug ? `${localID}-${titleSlug}` : localID;
  const branch = `${policy.branch_prefix}${suffix}`.slice(0, 240).replace(/[.-]+$/g, "");
  if (branch.length === 0 || invalidRefText(branch)) throw new Error("derived Handoff branch name is invalid");
  return branch;
}

function slug(value: string, maximum: number): string {
  return value.normalize("NFKD").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maximum)
    .replace(/-+$/g, "");
}

function invalidRefText(value: string): boolean {
  return value.includes("..") || value.includes("//") || value.includes("@{") ||
    value.includes("~") || value.includes("^") || value.includes(":") || value.includes("?") ||
    value.includes("*") || value.includes("[") || value.endsWith(".lock") || value.startsWith("-");
}

function validateSelectedSummary(selectedPaths: readonly string[], summary: HandoffDiffSummary): void {
  if (summary.changed_files.length === 0) throw new Error("selected paths do not produce a commit");
  for (const path of summary.changed_files) {
    if (!selectedPaths.some((selected) => pathCoveredBy(path, selected))) {
      throw new Error(`Git Evidence returned an out-of-scope changed path: ${path}`);
    }
  }
}

function pathCoveredBy(path: string, selected: string): boolean {
  return path === selected || path.startsWith(`${selected}/`);
}

function parseStatus(output: Buffer): { conflict_count: number; paths: string[]; staged_change_count: number } {
  const fields = nulFields(output);
  const paths: string[] = [];
  let conflicts = 0;
  let staged = 0;
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.length < 3 || field[2] !== " ") throw new Error("Git status returned malformed porcelain output");
    const x = field[0]!;
    const y = field[1]!;
    paths.push(field.slice(3));
    if (x !== " " && x !== "?" && x !== "!") staged += 1;
    if (x === "U" || y === "U" || ["DD", "AA"].includes(`${x}${y}`)) conflicts += 1;
    if ([x, y].some((status) => status === "R" || status === "C")) {
      const original = fields[index + 1];
      if (!original) throw new Error("Git status returned a rename without its original path");
      paths.push(original);
      index += 1;
    }
  }
  return { conflict_count: conflicts, paths: [...new Set(paths)].sort(compareText), staged_change_count: staged };
}

function nulFields(output: Buffer): string[] {
  if (output.length === 0) return [];
  if (output.at(-1) !== 0) throw new Error("Git returned unterminated zero-delimited output");
  return output.subarray(0, -1).toString("utf8").split("\0");
}

function assertSamePaths(actual: readonly string[], expected: readonly string[], message: string): void {
  const left = [...actual].sort(compareText);
  const right = [...expected].sort(compareText);
  if (left.length !== right.length || left.some((path, index) => path !== right[index])) throw new Error(message);
}

function objectID(output: Buffer, label: string): string {
  const value = cleanOutput(output, label).toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error(`${label} is not a full object id`);
  return value;
}

function cleanOutput(output: Buffer, label: string): string {
  return requiredText(output.toString("utf8"), label, 8192);
}

function canonicalTimestamp(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error("local Git Handoff timestamp must use canonical ISO format");
  }
  return value;
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} is required`);
  const text = value.trim();
  if (text === "" || text.length > maximum || text.includes("\0")) throw new Error(`${label} is invalid`);
  return text;
}

function uniqueText(values: readonly string[], label: string, maximum: number): string[] {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  const normalized = values.map((value) => requiredText(value, label, maximum));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} must be unique`);
  return [...normalized];
}

function normalizedBranchReuse(value: LocalGitHandoffProjectPolicy["branch_reuse"]): "never" | "same_baseline" {
  if (value !== "never" && value !== "same_baseline") throw new Error("unsupported local Git branch reuse policy");
  return value;
}

function redactedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactEvidenceText(message).slice(0, 2048) || "local Git Handoff failed";
}

function compareText(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}
