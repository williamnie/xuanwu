import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";
import type { RunnerDatabase } from "../database.ts";
import type { ProviderEvent } from "../../providers/types.ts";
import {
  type RuntimeEvidenceCorrelation,
  ISSUE_LOG_INLINE_PAYLOAD_LIMIT_BYTES,
  ISSUE_LOG_ARTIFACT_THRESHOLD_BYTES,
  EARLY_ARTIFACT_METHODS,
  type IssueLogArtifactRef,
  gzipAsync,
  gunzipAsync,
  type IssueLogPayloadExternalizationPlan,
  jsonObject,
  ISSUE_LOG_ARTIFACT_ROOT,
  ISSUE_LOG_ARTIFACT_SCHEMA,
  compactObject,
  boundedString,
  SUMMARY_TEXT_BYTES,
  SUMMARY_COMMAND_BYTES,
  SUMMARY_PATH_BYTES,
  SUMMARY_ERROR_BYTES
} from "./issueEventsModel.ts";
import {
  issueLogArtifactPath,
  validateIssueLogArtifactRaw,
  issueLogArtifactRef,
  validateIssueLogArtifactBytes
} from "./issueEventsArtifactRead.ts";

export function storedIssueLogPayload(
  db: RunnerDatabase,
  event: ProviderEvent,
  correlation?: RuntimeEvidenceCorrelation
): string {
  const body = issueLogPayload(event, correlation);
  const serialized = JSON.stringify(body);
  if (!needsIssueLogArtifact(body, serialized)) return serialized;
  return boundedIssueLogSummary(body, writeIssueLogArtifact(db, serialized));
}

export function needsIssueLogArtifact(body: Record<string, unknown>, serialized: string): boolean {
  const bytes = Buffer.byteLength(serialized);
  const method = typeof body.raw_method === "string" ? body.raw_method : "";
  return bytes > ISSUE_LOG_INLINE_PAYLOAD_LIMIT_BYTES ||
    (bytes > ISSUE_LOG_ARTIFACT_THRESHOLD_BYTES && EARLY_ARTIFACT_METHODS.has(method));
}

export function boundedIssueLogSummary(body: Record<string, unknown>, artifact: IssueLogArtifactRef): string {
  const summary = JSON.stringify(issueLogArtifactSummary(body, artifact));
  if (Buffer.byteLength(summary) > ISSUE_LOG_INLINE_PAYLOAD_LIMIT_BYTES) {
    throw new Error("issue.log artifact summary exceeds inline payload limit");
  }
  return summary;
}

export async function writeIssueLogArtifactAsync(db: RunnerDatabase, payload: string): Promise<IssueLogArtifactRef> {
  const bytes = Buffer.from(payload);
  const compressed = await gzipAsync(bytes, { level: 9 });
  const artifact = issueLogArtifact(bytes, compressed);
  const path = issueLogArtifactPath(db, artifact.ref);
  try {
    const existing = await readFile(path);
    if (existing.byteLength !== artifact.stored_bytes) throw new Error("issue.log artifact stored byte count mismatch");
    const raw = await gunzipAsync(existing);
    validateIssueLogArtifactRaw(artifact, raw);
    return artifact;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, compressed, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return artifact;
}

function writeIssueLogArtifact(db: RunnerDatabase, payload: string): IssueLogArtifactRef {
  const built = buildIssueLogArtifact(payload);
  persistIssueLogArtifact(db, built.artifact, built.compressed);
  return built.artifact;
}

export function planIssueLogPayloadExternalization(
  storedPayload: string,
  minimumSavingsBytes = 1024
): IssueLogPayloadExternalizationPlan | null {
  if (!Number.isSafeInteger(minimumSavingsBytes) || minimumSavingsBytes < 0) {
    throw new Error("minimum savings bytes must be a non-negative integer");
  }
  if (issueLogArtifactRef(storedPayload)) return null;
  const body = jsonObject(storedPayload);
  if (!body) return null;
  const built = buildIssueLogArtifact(storedPayload);
  const summary = JSON.stringify(issueLogArtifactSummary(body, built.artifact));
  const storedBytes = Buffer.byteLength(summary);
  if (storedBytes > ISSUE_LOG_INLINE_PAYLOAD_LIMIT_BYTES) return null;
  const netSavings = built.artifact.bytes - storedBytes - built.artifact.stored_bytes;
  if (netSavings < minimumSavingsBytes) return null;
  return {
    artifact: built.artifact,
    compressed: built.compressed,
    net_savings_bytes: netSavings,
    original_bytes: built.artifact.bytes,
    original_payload: storedPayload,
    stored_bytes: storedBytes,
    stored_payload: summary
  };
}

export function persistPlannedIssueLogArtifact(
  db: Pick<RunnerDatabase, "path">,
  plan: IssueLogPayloadExternalizationPlan
): boolean {
  return persistIssueLogArtifact(db, plan.artifact, plan.compressed);
}

function buildIssueLogArtifact(payload: string): { artifact: IssueLogArtifactRef; compressed: Buffer } {
  const bytes = Buffer.from(payload);
  const compressed = gzipSync(bytes, { level: 9 });
  return { artifact: issueLogArtifact(bytes, compressed), compressed };
}

function issueLogArtifact(bytes: Buffer, compressed: Buffer): IssueLogArtifactRef {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const ref = `${ISSUE_LOG_ARTIFACT_ROOT}/${sha256.slice(0, 2)}/${sha256}.json.gz`;
  return {
    bytes: bytes.byteLength,
    encoding: "gzip+json",
    ref,
    schema_version: ISSUE_LOG_ARTIFACT_SCHEMA,
    sha256,
    stored_bytes: compressed.byteLength
  };
}

function persistIssueLogArtifact(
  db: Pick<RunnerDatabase, "path">,
  artifact: IssueLogArtifactRef,
  compressed: Buffer
): boolean {
  const path = issueLogArtifactPath(db, artifact.ref);
  if (existsSync(path)) {
    validateIssueLogArtifactBytes(artifact, readFileSync(path));
    return false;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, compressed, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return true;
}

function issueLogArtifactSummary(
  payload: Record<string, unknown>,
  artifact: IssueLogArtifactRef
): Record<string, unknown> {
  const diagnostic = payload.type === "error" || payload.status === "failed" || payload.status === "error";
  return compactObject({
    type: boundedString(payload.type, 256),
    provider: boundedString(payload.provider, 256),
    raw_method: boundedString(payload.raw_method, 512),
    text: boundedString(payload.text, SUMMARY_TEXT_BYTES),
    command: boundedString(payload.command, SUMMARY_COMMAND_BYTES),
    path: boundedString(payload.path, SUMMARY_PATH_BYTES),
    status: boundedString(payload.status, 256),
    error: boundedString(payload.error, SUMMARY_ERROR_BYTES),
    runtime_evidence_correlation: payload.runtime_evidence_correlation,
    raw_payload: diagnostic ? boundedString(payload.raw_payload, SUMMARY_ERROR_BYTES) : undefined,
    run_event: payload.run_event,
    issue_log_artifact: artifact
  });
}

export function issueLogPayload(
  event: ProviderEvent,
  correlation?: RuntimeEvidenceCorrelation
): Record<string, unknown> {
  return compactObject({
    type: event.type,
    provider: event.provider,
    raw_method: event.raw?.method,
    raw_payload: event.raw?.payload,
    payload: event.payload,
    text: event.text,
    command: event.command,
    path: event.path,
    status: event.status,
    error: event.error,
    run_event: event.runEvent,
    runtime_evidence_correlation: correlation
  });
}
