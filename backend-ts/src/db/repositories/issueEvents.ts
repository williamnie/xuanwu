import type { RunnerDatabase } from "../database.ts";
import type { ProviderEvent } from "../../providers/types.ts";
import { cleanString, issueTimestamp } from "./issueCreate.ts";
import {
  type ListIssueEventsOptions,
  type IssueEvent,
  ensureIssueExists,
  type IssueEventRow,
  positiveInteger,
  type CreateIssueCommentInput,
  normalizeCommentAuthor,
  lastInsertID,
  type RuntimeEvidenceCorrelation
} from "./issueEventsModel.ts";
import { issueEventListQuery, mapIssueEventRow, mustGetIssueEvent } from "./issueEventsQueries.ts";
import {
  storedIssueLogPayload,
  issueLogPayload,
  needsIssueLogArtifact,
  boundedIssueLogSummary,
  writeIssueLogArtifactAsync
} from "./issueEventsArtifactWrite.ts";

export function listIssueEvents(
  db: RunnerDatabase,
  issueID: number,
  options: ListIssueEventsOptions = {}
): IssueEvent[] {
  ensureIssueExists(db, issueID);
  const query = issueEventListQuery(issueID, options);
  const rows = db.sqlite.query<IssueEventRow, Array<number | string>>(query.sql)
    .all(...query.args)
    .map((row) => mapIssueEventRow(db, row, options.hydrateArtifacts !== false));
  return query.reverseResult ? rows.reverse() : rows;
}

/**
 * Reads one latest event of the requested type for each Issue in a single
 * query. Work list projections use this instead of issuing one query per row.
 */
export function latestIssueEventsByIssueID(
  db: RunnerDatabase,
  issueIDs: number[],
  type: string
): Map<number, IssueEvent> {
  const ids = [...new Set(issueIDs.map((id) => positiveInteger(id, "issue id")))];
  const eventType = type.trim();
  if (ids.length === 0) return new Map();
  if (ids.length > 100) throw new Error("latest Issue event batch supports at most 100 Issues");
  if (eventType === "") throw new Error("Issue event type is required");
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db.sqlite.query<IssueEventRow, Array<number | string>>(`
    select event.id, event.issue_id, event.type, event.payload, event.created_at
    from issue_events event
    join (
      select issue_id, max(id) as id
      from issue_events
      where issue_id in (${placeholders}) and type=?
      group by issue_id
    ) latest on latest.id=event.id
  `).all(...ids, eventType);
  return new Map(rows.map((row) => {
    const event = mapIssueEventRow(db, row, true);
    return [event.issue_id, event];
  }));
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

export function recordIssueLogEvent(
  db: RunnerDatabase,
  issueID: number,
  event: ProviderEvent,
  correlation?: RuntimeEvidenceCorrelation
): IssueEvent {
  ensureIssueExists(db, issueID);
  const timestamp = issueTimestamp();
  const payload = storedIssueLogPayload(db, event, correlation);
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, "issue.log", payload, timestamp]
  );
  // Live publication uses the bounded stored form. Repository reads hydrate the
  // artifact back to the legacy payload so existing consumers stay compatible.
  return mustGetIssueEvent(db, lastInsertID(db), false);
}

/** 实时日志由调用方串行 await，避免压缩和文件 I/O 阻塞 Provider 事件循环。 */
export async function recordIssueLogEventAsync(
  db: RunnerDatabase,
  issueID: number,
  event: ProviderEvent,
  correlation?: RuntimeEvidenceCorrelation
): Promise<IssueEvent> {
  ensureIssueExists(db, issueID);
  const timestamp = issueTimestamp();
  const body = issueLogPayload(event, correlation);
  const serialized = JSON.stringify(body);
  const payload = needsIssueLogArtifact(body, serialized)
    ? boundedIssueLogSummary(body, await writeIssueLogArtifactAsync(db, serialized))
    : serialized;
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, "issue.log", payload, timestamp]
  );
  return mustGetIssueEvent(db, lastInsertID(db), false);
}

export type { IssueEvent } from "./issueEventsModel.ts";
export type { ListIssueEventsOptions } from "./issueEventsModel.ts";
export { ISSUE_LOG_INLINE_PAYLOAD_LIMIT_BYTES } from "./issueEventsModel.ts";
export { ISSUE_LOG_ARTIFACT_THRESHOLD_BYTES } from "./issueEventsModel.ts";
export type { IssueLogPayloadExternalizationPlan } from "./issueEventsModel.ts";
export { RUNTIME_EVIDENCE_CORRELATION_CONTRACT } from "./issueEventsModel.ts";
export type { RuntimeEvidenceCorrelation } from "./issueEventsModel.ts";
export { planIssueLogPayloadExternalization } from "./issueEventsArtifactWrite.ts";
export { persistPlannedIssueLogArtifact } from "./issueEventsArtifactWrite.ts";
export { hydrateStoredIssueLogPayload } from "./issueEventsArtifactRead.ts";
export { hydrateStoredIssueLogPayloadStrict } from "./issueEventsArtifactRead.ts";
