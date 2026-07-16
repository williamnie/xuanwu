import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  validateEvidence,
  type EvidenceID,
  type EvidenceRecord
} from "../evidence/contracts.ts";
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

type LoadedFileDetails = {
  detail_level: HandoffDiffSummary["detail_level"];
  files: GitChangedFileDetail[];
};

const GENERATED_DIRECTORY_NAMES = new Set([
  ".next",
  "build",
  "coverage",
  "dist",
  "gen",
  "generated",
  "out"
]);
const GENERATED_BASENAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "podfile.lock",
  "pubspec.lock",
  "yarn.lock"
]);

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

function validateGitEvidence(evidence: EvidenceRecord): void {
  const validation = validateEvidence(evidence);
  if (!validation.ok) throw new Error(`invalid Git Evidence: ${validation.errors.join("; ")}`);
  if (evidence.kind !== "git") throw new Error("Handoff Diff Summary requires Git Evidence");
  if (evidence.status !== "passed") throw new Error("Handoff Diff Summary requires passed Git Evidence");
  if (evidence.provenance.assertion_origin !== "system_observation" ||
    evidence.provenance.source_kind !== "git_repository") {
    throw new Error("Handoff Diff Summary requires trusted Git repository observation");
  }
}

function loadChangedFiles(
  evidence: EvidenceRecord,
  artifact: GitSnapshotArtifactInput | undefined
): LoadedFileDetails {
  const facts = evidence.decisive_output.facts;
  const inline = facts.changed_paths_inline;
  if (typeof inline !== "boolean") throw new Error("Git Evidence changed_paths_inline must be a boolean");

  if (inline) {
    const paths = parsePathArray(facts.changed_paths_json, "changed_paths_json");
    const detailsValue = facts.changed_file_details_json;
    if (detailsValue === undefined || detailsValue === null) {
      return { detail_level: "paths_only_v1", files: legacyDetails(paths) };
    }
    const files = parseFileDetails(detailsValue, "changed_file_details_json");
    assertSamePaths(paths, files.map((file) => file.path));
    return { detail_level: "per_file_v2", files };
  }

  if (!artifact) throw new Error("Git Evidence changed files require its snapshot artifact");
  const artifactRef = evidence.artifact_refs.find((candidate) => candidate.ref === artifact.ref);
  if (!artifactRef?.sha256) throw new Error("Git snapshot artifact is not referenced with a sha256 digest");
  const actualSha256 = createHash("sha256").update(artifact.content).digest("hex");
  if (actualSha256 !== artifactRef.sha256) throw new Error("Git snapshot artifact checksum mismatch");
  const manifest = parseJSONObject(artifact.content, "Git snapshot artifact");
  const paths = parsePathArray(manifest.changed_paths, "artifact changed_paths", false);
  if (manifest.schema_version === 1) {
    return { detail_level: "paths_only_v1", files: legacyDetails(paths) };
  }
  if (manifest.schema_version !== 2) throw new Error("unsupported Git snapshot artifact schema version");
  const files = parseFileDetails(manifest.changed_files, "artifact changed_files", false);
  assertSamePaths(paths, files.map((file) => file.path));
  return { detail_level: "per_file_v2", files };
}

function parsePathArray(value: unknown, label: string, encoded = true): string[] {
  const parsed = encoded ? parseJSON(value, label) : value;
  if (!Array.isArray(parsed)) throw new Error(`${label} must be an array`);
  const paths = parsed.map((path) => normalizedPath(path, label));
  const sorted = sortedUnique(paths);
  if (sorted.length !== paths.length) throw new Error(`${label} paths must be unique`);
  return sorted;
}

function parseFileDetails(value: unknown, label: string, encoded = true): GitChangedFileDetail[] {
  const parsed = encoded ? parseJSON(value, label) : value;
  if (!Array.isArray(parsed)) throw new Error(`${label} must be an array`);
  const files = parsed.map((item, index) => {
    if (!isRecord(item)) throw new Error(`${label}[${index}] must be an object`);
    const path = normalizedPath(item.path, `${label}[${index}].path`);
    const binary = nullableBoolean(item.binary, `${label}[${index}].binary`);
    const additions = nullableCountValue(item.additions, `${label}[${index}].additions`);
    const deletions = nullableCountValue(item.deletions, `${label}[${index}].deletions`);
    const sizeBytes = nullableCountValue(item.size_bytes, `${label}[${index}].size_bytes`);
    if (binary === true && (additions !== null || deletions !== null)) {
      throw new Error(`${label}[${index}] binary files cannot claim line stats`);
    }
    if (binary === false && (additions === null || deletions === null)) {
      throw new Error(`${label}[${index}] text diff files require line stats`);
    }
    if (binary === null && (additions !== null || deletions !== null)) {
      throw new Error(`${label}[${index}] files outside the tracked diff cannot claim line stats`);
    }
    return { additions, binary, deletions, path, size_bytes: sizeBytes };
  }).sort((left, right) => compareText(left.path, right.path));
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error(`${label} paths must be unique`);
  }
  return files;
}

function validateDetailedStats(
  files: readonly GitChangedFileDetail[],
  expected: {
    binaryFileCount: number;
    deletions: number;
    insertions: number;
    trackedDiffFileCount: number;
  }
): void {
  const tracked = files.filter((file) => file.binary !== null);
  const actual = {
    binaryFileCount: tracked.filter((file) => file.binary).length,
    deletions: tracked.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    insertions: tracked.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    trackedDiffFileCount: tracked.length
  };
  if (actual.trackedDiffFileCount !== expected.trackedDiffFileCount ||
    actual.insertions !== expected.insertions ||
    actual.deletions !== expected.deletions ||
    actual.binaryFileCount !== expected.binaryFileCount) {
    throw new Error("Git Evidence aggregate diff stats do not match per-file details");
  }
}

function legacyDetails(paths: readonly string[]): GitChangedFileDetail[] {
  return paths.map((path) => ({
    additions: null,
    binary: null,
    deletions: null,
    path,
    size_bytes: null
  }));
}

function groupPaths(paths: readonly string[]): HandoffDiffSummary["path_groups"] {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const slash = path.indexOf("/");
    const group = slash < 0 ? "(root)" : path.slice(0, slash);
    const files = groups.get(group) ?? [];
    files.push(path);
    groups.set(group, files);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([group, files]) => ({ group, files: [...files].sort(compareText) }));
}

function isGeneratedPath(path: string): boolean {
  const normalized = path.toLowerCase();
  const segments = normalized.split("/");
  const basename = segments.at(-1)!;
  if (segments.some((segment) => GENERATED_DIRECTORY_NAMES.has(segment))) return true;
  if (GENERATED_BASENAMES.has(basename)) return true;
  return /(?:\.generated\.|\.gen\.|\.g\.dart$|\.freezed\.dart$|\.pb\.(?:go|js|ts)$|_pb2\.py$|\.min\.(?:css|js)$)/.test(basename);
}

function summaryText(input: {
  binaryFileCount: number;
  changedPathCount: number;
  deletions: number;
  generatedFileCount: number;
  groupCount: number;
  insertions: number;
  largeFileCount: number;
  trackedDiffFileCount: number;
  untrackedFileCount: number | null;
}): string {
  const untracked = input.untrackedFileCount === null
    ? "untracked paths were not observed"
    : `${input.untrackedFileCount} untracked path(s)`;
  return `${input.changedPathCount} changed path(s) across ${input.groupCount} group(s); ` +
    `tracked diff ${input.trackedDiffFileCount} file(s) (+${input.insertions}/-${input.deletions}); ` +
    `${input.binaryFileCount} binary, ${input.largeFileCount} large, ` +
    `${input.generatedFileCount} generated-looking; ${untracked}.`;
}

function notificationSummaryText(input: {
  binaryFileCount: number;
  changedPathCount: number;
  deletions: number;
  generatedFileCount: number;
  insertions: number;
  largeFileCount: number;
}): string {
  return `${input.changedPathCount} changed path(s); +${input.insertions}/-${input.deletions}; ` +
    `${input.binaryFileCount} binary; ${input.largeFileCount} large; ` +
    `${input.generatedFileCount} generated-looking.`;
}

function riskHints(
  evidenceID: EvidenceID,
  input: {
    binaryFileCount: number;
    generatedFileCount: number;
    largeFileCount: number;
    legacyDetails: boolean;
  }
): HandoffDiffSummary["risk_hints"] {
  const sourceRefs = [evidenceID];
  const risks: HandoffDiffSummary["risk_hints"] = [];
  if (input.binaryFileCount > 0) risks.push({
    id: "binary_diff",
    severity: "medium",
    summary: `${input.binaryFileCount} binary changed file(s) cannot be reviewed with line diff stats`,
    mitigation: "Review the binary artifact, provenance, and expected checksum separately",
    source_refs: sourceRefs
  });
  if (input.largeFileCount > 0) risks.push({
    id: "large_files",
    severity: "medium",
    summary: `${input.largeFileCount} current worktree file(s) meet the large-file threshold`,
    mitigation: "Confirm repository size policy and use an artifact store when appropriate",
    source_refs: sourceRefs
  });
  if (input.generatedFileCount > 0) risks.push({
    id: "generated_files",
    severity: "low",
    summary: `${input.generatedFileCount} changed path(s) match the generated-file heuristic`,
    mitigation: "Review the source change and verify the documented regeneration command",
    source_refs: sourceRefs
  });
  if (input.legacyDetails) risks.push({
    id: "file_metadata_unavailable",
    severity: "low",
    summary: "Legacy Git Evidence provides paths and aggregate stats without per-file metadata",
    mitigation: "Collect a fresh Git Evidence snapshot before binary-path or large-file review",
    source_refs: sourceRefs
  });
  return risks;
}

function nonNegativeIntegerFact(facts: Record<string, unknown>, key: string): number {
  return nonNegativeInteger(facts[key], `Git Evidence ${key}`);
}

function nullableNonNegativeIntegerFact(facts: Record<string, unknown>, key: string): number | null {
  if (facts[key] === null) return null;
  return nonNegativeIntegerFact(facts, key);
}

function sha256Fact(facts: Record<string, unknown>, key: string): string {
  const value = facts[key];
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Git Evidence ${key} must be a sha256 digest`);
  }
  return value;
}

function parseJSON(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new Error(`Git Evidence ${label} must be an inline JSON string`);
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Git Evidence ${label} is not valid JSON`);
  }
}

function parseJSONObject(value: string, label: string): Record<string, unknown> {
  const parsed = parseJSON(value, label);
  if (!isRecord(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed;
}

function assertSamePaths(left: readonly string[], right: readonly string[]): void {
  if (left.length !== right.length || left.some((path, index) => path !== right[index])) {
    throw new Error("Git Evidence changed paths do not match per-file details");
  }
}

function normalizedPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty Git path up to 4096 characters`);
  }
  return value;
}

function nullableBoolean(value: unknown, label: string): boolean | null {
  if (value === null || typeof value === "boolean") return value;
  throw new Error(`${label} must be boolean or null`);
}

function nullableCountValue(value: unknown, label: string): number | null {
  if (value === null) return null;
  return nonNegativeInteger(value, label);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
