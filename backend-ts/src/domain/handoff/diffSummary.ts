import { Value } from "@sinclair/typebox/value";
import type { GitChangedFileDetail } from "../evidence/gitCollector.ts";
import {
  type BuildHandoffDiffSummaryInput,
  type HandoffDiffSummary,
  HANDOFF_LARGE_FILE_THRESHOLD_BYTES,
  HANDOFF_DIFF_SUMMARY_SCHEMA_VERSION,
  HANDOFF_GENERATED_PATH_RULE_REF,
  HANDOFF_DIFF_SUMMARY_SCHEMA
} from "./diffSummaryModel.ts";
import {
  validateGitEvidence,
  nonNegativeIntegerFact,
  nullableNonNegativeIntegerFact,
  sha256Fact,
  loadChangedFiles,
  validateDetailedStats
} from "./diffSummaryArtifacts.ts";
import {
  groupPaths,
  isGeneratedPath,
  summaryText,
  notificationSummaryText,
  riskHints
} from "./diffSummaryPresentation.ts";

export function buildHandoffDiffSummary(input: BuildHandoffDiffSummaryInput): HandoffDiffSummary {
  const evidence = input.git_evidence;
  validateGitEvidence(evidence);
  const facts = evidence.decisive_output.facts;
  const changedPathCount = nonNegativeIntegerFact(facts, "changed_path_count");
  const trackedDiffFileCount = nonNegativeIntegerFact(facts, "diff_changed_file_count");
  const insertions = nonNegativeIntegerFact(facts, "insertions");
  const deletions = nonNegativeIntegerFact(facts, "deletions");
  const binaryFileCount = nonNegativeIntegerFact(facts, "binary_file_count");
  const untrackedFileCount = nullableNonNegativeIntegerFact(facts, "untracked_count");
  const snapshotSha256 = sha256Fact(facts, "snapshot_sha256");
  const loaded = loadChangedFiles(evidence, input.snapshot_artifact);
  const changedFiles = loaded.files.map((file) => file.path);

  if (changedFiles.length !== changedPathCount) {
    throw new Error("Git Evidence changed_path_count does not match its changed file list");
  }
  if (loaded.detail_level === "per_file_v2") {
    validateDetailedStats(loaded.files, {
      binaryFileCount,
      deletions,
      insertions,
      trackedDiffFileCount
    });
  }

  const pathGroups = groupPaths(changedFiles);
  const binaryFiles = loaded.files.filter((file) => file.binary === true).map((file) => file.path);
  const largeFiles = loaded.files
    .filter((file): file is GitChangedFileDetail & { size_bytes: number } =>
      file.size_bytes !== null && file.size_bytes >= HANDOFF_LARGE_FILE_THRESHOLD_BYTES
    )
    .map((file) => ({ path: file.path, size_bytes: file.size_bytes }));
  const generatedFiles = changedFiles.filter(isGeneratedPath);
  const summary = summaryText({
    binaryFileCount,
    changedPathCount,
    deletions,
    generatedFileCount: generatedFiles.length,
    groupCount: pathGroups.length,
    insertions,
    largeFileCount: largeFiles.length,
    trackedDiffFileCount,
    untrackedFileCount
  });
  const notificationSummary = notificationSummaryText({
    binaryFileCount,
    changedPathCount,
    deletions,
    generatedFileCount: generatedFiles.length,
    insertions,
    largeFileCount: largeFiles.length
  });

  const result: HandoffDiffSummary = {
    schema_version: HANDOFF_DIFF_SUMMARY_SCHEMA_VERSION,
    source_evidence_id: evidence.id,
    snapshot_sha256: snapshotSha256,
    detail_level: loaded.detail_level,
    changed_files: changedFiles,
    path_groups: pathGroups,
    diff_stats: {
      changed_path_count: changedPathCount,
      tracked_diff_file_count: trackedDiffFileCount,
      insertions,
      deletions,
      binary_file_count: binaryFileCount,
      untracked_file_count: untrackedFileCount
    },
    notable_files: {
      binary: binaryFiles,
      large: largeFiles,
      generated: generatedFiles
    },
    classification: {
      binary_path_scope: "tracked_diff_only",
      file_size_scope: "present_worktree_only",
      generated_rule_ref: HANDOFF_GENERATED_PATH_RULE_REF,
      large_file_threshold_bytes: HANDOFF_LARGE_FILE_THRESHOLD_BYTES
    },
    summary,
    notification_summary: notificationSummary,
    risk_hints: riskHints(evidence.id, {
      binaryFileCount,
      generatedFileCount: generatedFiles.length,
      largeFileCount: largeFiles.length,
      legacyDetails: loaded.detail_level === "paths_only_v1"
    })
  };
  if (!Value.Check(HANDOFF_DIFF_SUMMARY_SCHEMA, result)) {
    const errors = [...Value.Errors(HANDOFF_DIFF_SUMMARY_SCHEMA, result)]
      .map((error) => `${error.path || "/"}: ${error.message}`);
    throw new Error(`Handoff Diff Summary failed schema validation: ${errors.join("; ")}`);
  }
  return result;
}

export { HANDOFF_LARGE_FILE_THRESHOLD_BYTES } from "./diffSummaryModel.ts";
export { HANDOFF_DIFF_SUMMARY_SCHEMA } from "./diffSummaryModel.ts";
export type { HandoffDiffSummary } from "./diffSummaryModel.ts";
