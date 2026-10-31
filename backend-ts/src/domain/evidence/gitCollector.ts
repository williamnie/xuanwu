import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { createLocalGitAdapter } from "../git/adapter.ts";
import {
  EVIDENCE_SCHEMA_VERSION,
  redactEvidenceRecord,
  redactEvidenceText,
  validateEvidence,
  type EvidenceRecord
} from "./contracts.ts";
import {
  type GitEvidenceCollectorOptions,
  type GitEvidenceCollector,
  type GitChangedFileDetail,
  type GitSnapshotManifest,
  MAX_FACT_TEXT_BYTES
} from "./gitCollectorModel.ts";
import {
  validateInput,
  repositoryRootPath,
  normalizedPathspecs,
  cleanOutput,
  normalizedObjectID,
  normalizedBaseRevision,
  parseGitStatus,
  parseGitNumstat,
  diffArguments,
  sortedUnique,
  workingTreeFileSize,
  uniqueArtifactRefs,
  normalizedTimestamp,
  gitSnapshotSummary
} from "./gitCollectorParsing.ts";

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

export type { CollectGitEvidenceInput } from "./gitCollectorModel.ts";
export type { GitEvidenceCollector } from "./gitCollectorModel.ts";
export type { GitChangedFileDetail } from "./gitCollectorModel.ts";
export type { GitSnapshotManifest } from "./gitCollectorModel.ts";
export { FileSystemGitEvidenceArtifactStore } from "./gitCollectorArtifacts.ts";
