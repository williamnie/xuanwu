import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { RunnerDatabase } from "../database.ts";
import type { ProviderEvent } from "../../providers/types.ts";
import { cleanString, issueTimestamp } from "./issueCreate.ts";
import { getIssue } from "./issues.ts";
import { ProjectNotFoundError } from "./projects.ts";

export type IssueEvent = {
  created_at: string;
  id: number;
  issue_id: number;
  payload: string;
  type: string;
};

type IssueEventRow = {
  created_at: unknown;
  id: unknown;
  issue_id: unknown;
  payload: unknown;
  type: unknown;
};

type CreateIssueCommentInput = {
  author?: unknown;
  body?: unknown;
};

export type ListIssueEventsOptions = {
  afterID?: number;
  beforeID?: number;
  excludeTypes?: string[];
  limit?: number;
  types?: string[];
};

export const ISSUE_LOG_INLINE_PAYLOAD_LIMIT_BYTES = 64 * 1024;

const ISSUE_LOG_ARTIFACT_ROOT = "artifacts/issue-logs";
const ISSUE_LOG_ARTIFACT_SCHEMA = "issue-log-payload-artifact.v1";
const SUMMARY_TEXT_BYTES = 16 * 1024;
const SUMMARY_ERROR_BYTES = 16 * 1024;
const SUMMARY_COMMAND_BYTES = 4 * 1024;
const SUMMARY_PATH_BYTES = 2 * 1024;

type IssueLogArtifactRef = {
  bytes: number;
  encoding: "gzip+json";
  ref: string;
  schema_version: typeof ISSUE_LOG_ARTIFACT_SCHEMA;
  sha256: string;
  stored_bytes: number;
};

export function listIssueEvents(
  db: RunnerDatabase,
  issueID: number,
  options: ListIssueEventsOptions = {}
): IssueEvent[] {
  ensureIssueExists(db, issueID);
  const query = issueEventListQuery(issueID, options);
  const rows = db.sqlite.query<IssueEventRow, Array<number | string>>(query.sql)
    .all(...query.args)
    .map((row) => mapIssueEventRow(db, row, true));
  return query.reverseResult ? rows.reverse() : rows;
}

export function createIssueComment(db: RunnerDatabase, issueID: number, input: CreateIssueCommentInput): IssueEvent {
  ensureIssueExists(db, issueID);
  const body = cleanString(input.body);
  if (body === "") throw new Error("评论内容不能为空");
  const author = normalizeCommentAuthor(input.author);
  const timestamp = issueTimestamp();
  const payload = JSON.stringify({ author, body });
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, "issue.comment", payload, timestamp]
  );
  return mustGetIssueEvent(db, lastInsertID(db));
}


export function recordIssueEvent(db: RunnerDatabase, issueID: number, type: string, payload: unknown): IssueEvent {
  ensureIssueExists(db, issueID);
  const body = typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, type, body, issueTimestamp()]
  );
  return mustGetIssueEvent(db, lastInsertID(db));
}

export function recordIssueLogEvent(db: RunnerDatabase, issueID: number, event: ProviderEvent): IssueEvent {
  ensureIssueExists(db, issueID);
  const timestamp = issueTimestamp();
  const payload = storedIssueLogPayload(db, event);
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, "issue.log", payload, timestamp]
  );
  // Live publication uses the bounded stored form. Repository reads hydrate the
  // artifact back to the legacy payload so existing consumers stay compatible.
  return mustGetIssueEvent(db, lastInsertID(db), false);
}

function storedIssueLogPayload(db: RunnerDatabase, event: ProviderEvent): string {
  const body = issueLogPayload(event);
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized) <= ISSUE_LOG_INLINE_PAYLOAD_LIMIT_BYTES) return serialized;
  const artifact = writeIssueLogArtifact(db, serialized);
  const summary = JSON.stringify(issueLogArtifactSummary(body, artifact));
  if (Buffer.byteLength(summary) > ISSUE_LOG_INLINE_PAYLOAD_LIMIT_BYTES) {
    throw new Error("issue.log artifact summary exceeds inline payload limit");
  }
  return summary;
}

function writeIssueLogArtifact(db: RunnerDatabase, payload: string): IssueLogArtifactRef {
  const bytes = Buffer.from(payload);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const ref = `${ISSUE_LOG_ARTIFACT_ROOT}/${sha256.slice(0, 2)}/${sha256}.json.gz`;
  const path = issueLogArtifactPath(db, ref);
  const compressed = gzipSync(bytes, { level: 9 });
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, compressed, { flag: "wx", mode: 0o600 });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return {
    bytes: bytes.byteLength,
    encoding: "gzip+json",
    ref,
    schema_version: ISSUE_LOG_ARTIFACT_SCHEMA,
    sha256,
    stored_bytes: compressed.byteLength
  };
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
    raw_payload: diagnostic ? boundedString(payload.raw_payload, SUMMARY_ERROR_BYTES) : undefined,
    run_event: payload.run_event,
    issue_log_artifact: artifact
  });
}

function issueLogPayload(event: ProviderEvent): Record<string, unknown> {
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
    run_event: event.runEvent
  });
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== ""));
}

function normalizeCommentAuthor(value: unknown): string {
  const author = cleanString(value) || "user";
  if (author === "user" || author === "agent" || author === "system") return author;
  throw new Error("评论作者必须是 user、agent 或 system");
}

function issueEventListQuery(
  issueID: number,
  options: ListIssueEventsOptions
): { args: Array<number | string>; reverseResult: boolean; sql: string } {
  const clauses = ["issue_id = ?"];
  const args: Array<number | string> = [issueID];
  const types = normalizedEventTypes(options.types);
  const excludeTypes = normalizedEventTypes(options.excludeTypes);

  if (types.length > 0) {
    clauses.push(`type in (${types.map(() => "?").join(", ")})`);
    args.push(...types);
  }
  if (excludeTypes.length > 0) {
    clauses.push(`type not in (${excludeTypes.map(() => "?").join(", ")})`);
    args.push(...excludeTypes);
  }
  if (options.beforeID !== undefined) {
    clauses.push("id < ?");
    args.push(options.beforeID);
  }
  if (options.afterID !== undefined) {
    clauses.push("id > ?");
    args.push(options.afterID);
  }

  const limit = normalizedEventLimit(options.limit);
  const reverseResult = limit !== undefined && options.afterID === undefined;
  const cursorQuery = options.beforeID !== undefined || options.afterID !== undefined;
  const order = reverseResult ? "id desc" : cursorQuery ? "id asc" : "created_at asc, id asc";
  const limitClause = limit === undefined ? "" : " limit ?";
  if (limit !== undefined) args.push(limit);

  return {
    args,
    reverseResult,
    sql: `select id, issue_id, type, payload, created_at from issue_events
      where ${clauses.join(" and ")} order by ${order}${limitClause}`
  };
}

function normalizedEventTypes(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizedEventLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 500) {
    throw new Error("事件 limit 必须是 1 到 500 的整数");
  }
  return value;
}

function ensureIssueExists(db: RunnerDatabase, id: number): void {
  if (!getIssue(db, id)) throw new ProjectNotFoundError();
}

function mustGetIssueEvent(db: RunnerDatabase, id: number, hydrateArtifacts = true): IssueEvent {
  const row = db.sqlite.query<IssueEventRow, [number]>(`
    select id, issue_id, type, payload, created_at from issue_events where id = ?
  `).get(id);
  if (!row) throw new Error("created issue event missing");
  return mapIssueEventRow(db, row, hydrateArtifacts);
}

function mapIssueEventRow(db: RunnerDatabase, row: IssueEventRow, hydrateArtifacts: boolean): IssueEvent {
  const storedPayload = optionalString(row.payload);
  const type = requiredString(row.type, "issue_events.type");
  return {
    id: positiveInteger(row.id, "issue_events.id"),
    issue_id: positiveInteger(row.issue_id, "issue_events.issue_id"),
    type,
    payload: hydrateArtifacts && type === "issue.log" ? hydratedIssueLogPayload(db, storedPayload) : storedPayload,
    created_at: requiredString(row.created_at, "issue_events.created_at")
  };
}

function hydratedIssueLogPayload(db: RunnerDatabase, storedPayload: string): string {
  const artifact = issueLogArtifactRef(storedPayload);
  if (!artifact) return storedPayload;
  try {
    const compressed = readFileSync(issueLogArtifactPath(db, artifact.ref));
    if (compressed.byteLength !== artifact.stored_bytes) return storedPayload;
    const raw = gunzipSync(compressed);
    if (raw.byteLength !== artifact.bytes) return storedPayload;
    if (createHash("sha256").update(raw).digest("hex") !== artifact.sha256) return storedPayload;
    const payload = raw.toString("utf8");
    JSON.parse(payload);
    return payload;
  } catch {
    // The bounded inline diagnostic remains readable if an artifact is missing or corrupt.
    return storedPayload;
  }
}

function issueLogArtifactRef(payload: string): IssueLogArtifactRef | undefined {
  try {
    const body = JSON.parse(payload) as Record<string, unknown>;
    const value = body.issue_log_artifact;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const artifact = value as Record<string, unknown>;
    if (artifact.schema_version !== ISSUE_LOG_ARTIFACT_SCHEMA || artifact.encoding !== "gzip+json") return undefined;
    if (!safeArtifactRef(artifact.ref) || !sha256Text(artifact.sha256)) return undefined;
    if (!positiveArtifactBytes(artifact.bytes) || !positiveArtifactBytes(artifact.stored_bytes)) return undefined;
    const expectedRef = `${ISSUE_LOG_ARTIFACT_ROOT}/${artifact.sha256.slice(0, 2)}/${artifact.sha256}.json.gz`;
    if (artifact.ref !== expectedRef) return undefined;
    return {
      bytes: artifact.bytes,
      encoding: "gzip+json",
      ref: artifact.ref,
      schema_version: ISSUE_LOG_ARTIFACT_SCHEMA,
      sha256: artifact.sha256,
      stored_bytes: artifact.stored_bytes
    };
  } catch {
    return undefined;
  }
}

function issueLogArtifactPath(db: RunnerDatabase, ref: string): string {
  if (!safeArtifactRef(ref)) throw new Error("invalid issue.log artifact ref");
  const root = resolve(dirname(db.path), ISSUE_LOG_ARTIFACT_ROOT);
  const path = resolve(dirname(db.path), ref);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("issue.log artifact ref escapes state directory");
  return path;
}

function safeArtifactRef(value: unknown): value is string {
  return typeof value === "string" &&
    /^artifacts\/issue-logs\/[a-f0-9]{2}\/[a-f0-9]{64}\.json\.gz$/.test(value);
}

function sha256Text(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function positiveArtifactBytes(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function boundedString(value: unknown, byteLimit: number): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  if (Buffer.byteLength(value) <= byteLimit) return value;
  const marker = "\n…[truncated; full value in issue_log_artifact]";
  const bodyLimit = Math.max(0, byteLimit - Buffer.byteLength(marker));
  const bytes = Buffer.from(value);
  let end = Math.min(bytes.byteLength, bodyLimit);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}${marker}`;
}

function lastInsertID(db: RunnerDatabase): number {
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (typeof row?.id !== "number" || !Number.isInteger(row.id) || row.id <= 0) {
    throw new Error("inserted issue event id must be positive");
  }
  return row.id;
}

function requiredString(value: unknown, label: string): string {
  const text = optionalString(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}

function optionalString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new Error("expected string row value");
  return value.trim();
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be positive`);
  }
  return value;
}
