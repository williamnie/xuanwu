import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import type { RunnerDatabase } from "../database.ts";
import { cleanString } from "./issueCreate.ts";
import { getIssue } from "./issues.ts";
import { ProjectNotFoundError } from "./projects.ts";

export type IssueEvent = {
  created_at: string;
  id: number;
  issue_id: number;
  payload: string;
  type: string;
};

export type IssueEventRow = {
  created_at: unknown;
  id: unknown;
  issue_id: unknown;
  payload: unknown;
  type: unknown;
};

export type CreateIssueCommentInput = {
  author?: unknown;
  body?: unknown;
};

export type ListIssueEventsOptions = {
  afterID?: number;
  beforeID?: number;
  createdAfter?: string;
  excludeTypes?: string[];
  hydrateArtifacts?: boolean;
  limit?: number;
  types?: string[];
};

export const ISSUE_LOG_INLINE_PAYLOAD_LIMIT_BYTES = 64 * 1024;

export const ISSUE_LOG_ARTIFACT_THRESHOLD_BYTES = 8 * 1024;

export const ISSUE_LOG_ARTIFACT_ROOT = "artifacts/issue-logs";

export const ISSUE_LOG_ARTIFACT_SCHEMA = "issue-log-payload-artifact.v1";

export const SUMMARY_TEXT_BYTES = 16 * 1024;

export const SUMMARY_ERROR_BYTES = 16 * 1024;

export const SUMMARY_COMMAND_BYTES = 4 * 1024;

export const SUMMARY_PATH_BYTES = 2 * 1024;

export const ISSUE_LOG_ARTIFACT_ATTENTION_SOURCE = "runner.issue_log_artifact_integrity";

export const gzipAsync = promisify(gzip);

export const gunzipAsync = promisify(gunzip);

export const EARLY_ARTIFACT_METHODS = new Set([
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/started",
  "item/completed",
  "turn/diff/updated"
]);

export type IssueLogArtifactRef = {
  bytes: number;
  encoding: "gzip+json";
  ref: string;
  schema_version: typeof ISSUE_LOG_ARTIFACT_SCHEMA;
  sha256: string;
  stored_bytes: number;
};

export type IssueLogPayloadExternalizationPlan = {
  artifact: IssueLogArtifactRef;
  compressed: Buffer;
  net_savings_bytes: number;
  original_bytes: number;
  original_payload: string;
  stored_bytes: number;
  stored_payload: string;
};

export const RUNTIME_EVIDENCE_CORRELATION_CONTRACT = "xw.runtime-evidence-correlation.v1" as const;

export type RuntimeEvidenceCorrelation = {
  attempt_id: string;
  contract: typeof RUNTIME_EVIDENCE_CORRELATION_CONTRACT;
  issue_run_id: string;
  provider: string;
  provider_session_id: string;
  provider_turn_id: string;
  run_id: string;
};

export function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== ""));
}

export function normalizeCommentAuthor(value: unknown): string {
  const author = cleanString(value) || "user";
  if (author === "user" || author === "agent" || author === "system") return author;
  throw new Error("评论作者必须是 user、agent 或 system");
}

export function normalizedEventTypes(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function normalizedEventLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 500) {
    throw new Error("事件 limit 必须是 1 到 500 的整数");
  }
  return value;
}

export function ensureIssueExists(db: RunnerDatabase, id: number): void {
  if (!getIssue(db, id)) throw new ProjectNotFoundError();
}

export function jsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function safeArtifactRef(value: unknown): value is string {
  return typeof value === "string" &&
    /^artifacts\/issue-logs\/[a-f0-9]{2}\/[a-f0-9]{64}\.json\.gz$/.test(value);
}

export function sha256Text(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function positiveArtifactBytes(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function boundedString(value: unknown, byteLimit: number): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  if (Buffer.byteLength(value) <= byteLimit) return value;
  const marker = "\n…[truncated; full value in issue_log_artifact]";
  const bodyLimit = Math.max(0, byteLimit - Buffer.byteLength(marker));
  const bytes = Buffer.from(value);
  let end = Math.min(bytes.byteLength, bodyLimit);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}${marker}`;
}

export function lastInsertID(db: RunnerDatabase): number {
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (typeof row?.id !== "number" || !Number.isInteger(row.id) || row.id <= 0) {
    throw new Error("inserted issue event id must be positive");
  }
  return row.id;
}

export function requiredString(value: unknown, label: string): string {
  const text = optionalString(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}

export function optionalString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new Error("expected string row value");
  return value.trim();
}

export function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be positive`);
  }
  return value;
}
