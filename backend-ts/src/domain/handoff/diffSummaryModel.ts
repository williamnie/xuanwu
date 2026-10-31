import { Type, type Static } from "@sinclair/typebox";
import { type EvidenceID, type EvidenceRecord } from "../evidence/contracts.ts";
import type { GitChangedFileDetail } from "../evidence/gitCollector.ts";

export const HANDOFF_DIFF_SUMMARY_SCHEMA_VERSION = 1 as const;

export const HANDOFF_LARGE_FILE_THRESHOLD_BYTES = 5 * 1024 * 1024;

export const HANDOFF_GENERATED_PATH_RULE_REF = "handoff-generated-path:v1" as const;

const pathText = Type.String({ minLength: 1, maxLength: 4096 });

const count = Type.Integer({ minimum: 0 });

const nullableCount = Type.Union([count, Type.Null()]);

const evidenceIDSchema = Type.String({
  pattern: "^xw:evidence:(issue_events|pi_action_events|issue_supervisor_events|git):[A-Za-z0-9._~%-]+$"
});

export const HANDOFF_DIFF_SUMMARY_SCHEMA = Type.Object({
  schema_version: Type.Literal(HANDOFF_DIFF_SUMMARY_SCHEMA_VERSION),
  source_evidence_id: evidenceIDSchema,
  snapshot_sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  detail_level: Type.Union([Type.Literal("per_file_v2"), Type.Literal("paths_only_v1")]),
  changed_files: Type.Array(pathText, { maxItems: 4096 }),
  path_groups: Type.Array(Type.Object({
    group: pathText,
    files: Type.Array(pathText, { maxItems: 4096 })
  }, { additionalProperties: false }), { maxItems: 4096 }),
  diff_stats: Type.Object({
    changed_path_count: count,
    tracked_diff_file_count: count,
    insertions: count,
    deletions: count,
    binary_file_count: count,
    untracked_file_count: nullableCount
  }, { additionalProperties: false }),
  notable_files: Type.Object({
    binary: Type.Array(pathText, { maxItems: 4096 }),
    large: Type.Array(Type.Object({
      path: pathText,
      size_bytes: count
    }, { additionalProperties: false }), { maxItems: 4096 }),
    generated: Type.Array(pathText, { maxItems: 4096 })
  }, { additionalProperties: false }),
  classification: Type.Object({
    binary_path_scope: Type.Literal("tracked_diff_only"),
    file_size_scope: Type.Literal("present_worktree_only"),
    generated_rule_ref: Type.Literal(HANDOFF_GENERATED_PATH_RULE_REF),
    large_file_threshold_bytes: Type.Literal(HANDOFF_LARGE_FILE_THRESHOLD_BYTES)
  }, { additionalProperties: false }),
  summary: Type.String({ minLength: 1, maxLength: 4096 }),
  notification_summary: Type.String({ minLength: 1, maxLength: 1024 }),
  risk_hints: Type.Array(Type.Object({
    id: Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9_.-]*$" }),
    severity: Type.Union([
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("critical")
    ]),
    summary: Type.String({ minLength: 1, maxLength: 4096 }),
    mitigation: Type.String({ minLength: 1, maxLength: 4096 }),
    source_refs: Type.Array(Type.String({ minLength: 1, maxLength: 8192 }), { maxItems: 64 })
  }, { additionalProperties: false }), { maxItems: 256 })
}, { additionalProperties: false });

type HandoffDiffSummarySchemaValue = Static<typeof HANDOFF_DIFF_SUMMARY_SCHEMA>;

export type HandoffDiffSummary = Omit<HandoffDiffSummarySchemaValue, "source_evidence_id"> & {
  source_evidence_id: EvidenceID;
};

export type GitSnapshotArtifactInput = {
  content: string;
  ref: string;
};

export type BuildHandoffDiffSummaryInput = {
  git_evidence: EvidenceRecord;
  snapshot_artifact?: GitSnapshotArtifactInput;
};

export type LoadedFileDetails = {
  detail_level: HandoffDiffSummary["detail_level"];
  files: GitChangedFileDetail[];
};

export const GENERATED_DIRECTORY_NAMES = new Set([
  ".next",
  "build",
  "coverage",
  "dist",
  "gen",
  "generated",
  "out"
]);

export const GENERATED_BASENAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "podfile.lock",
  "pubspec.lock",
  "yarn.lock"
]);
