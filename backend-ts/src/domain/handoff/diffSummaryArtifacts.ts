import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { validateEvidence, type EvidenceRecord } from "../evidence/contracts.ts";
import type { GitChangedFileDetail } from "../evidence/gitCollector.ts";
import { isRecord } from "../../util/values.ts";
import { type GitSnapshotArtifactInput, type LoadedFileDetails } from "./diffSummaryModel.ts";

export function validateGitEvidence(evidence: EvidenceRecord): void {
  const validation = validateEvidence(evidence);
  if (!validation.ok) throw new Error(`invalid Git Evidence: ${validation.errors.join("; ")}`);
  if (evidence.kind !== "git") throw new Error("Handoff Diff Summary requires Git Evidence");
  if (evidence.status !== "passed") throw new Error("Handoff Diff Summary requires passed Git Evidence");
  if (evidence.provenance.assertion_origin !== "system_observation" ||
    evidence.provenance.source_kind !== "git_repository") {
    throw new Error("Handoff Diff Summary requires trusted Git repository observation");
  }
}

export function loadChangedFiles(
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

export function validateDetailedStats(
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

export function nonNegativeIntegerFact(facts: Record<string, unknown>, key: string): number {
  return nonNegativeInteger(facts[key], `Git Evidence ${key}`);
}

export function nullableNonNegativeIntegerFact(facts: Record<string, unknown>, key: string): number | null {
  if (facts[key] === null) return null;
  return nonNegativeIntegerFact(facts, key);
}

export function sha256Fact(facts: Record<string, unknown>, key: string): string {
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

export function compareText(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}
