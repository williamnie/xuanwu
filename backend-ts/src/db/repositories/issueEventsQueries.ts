import type { RunnerDatabase } from "../database.ts";
import {
  type ListIssueEventsOptions,
  normalizedEventTypes,
  normalizedEventLimit,
  type IssueEvent,
  type IssueEventRow,
  optionalString,
  requiredString,
  positiveInteger
} from "./issueEventsModel.ts";
import { hydratedIssueLogPayload } from "./issueEventsArtifactRead.ts";

export function issueEventListQuery(
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
  const createdAfter = options.createdAfter?.trim();
  if (createdAfter) {
    clauses.push("created_at > ?");
    args.push(createdAfter);
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

export function mustGetIssueEvent(db: RunnerDatabase, id: number, hydrateArtifacts = true): IssueEvent {
  const row = db.sqlite.query<IssueEventRow, [number]>(`
    select id, issue_id, type, payload, created_at from issue_events where id = ?
  `).get(id);
  if (!row) throw new Error("created issue event missing");
  return mapIssueEventRow(db, row, hydrateArtifacts);
}

export function mapIssueEventRow(db: RunnerDatabase, row: IssueEventRow, hydrateArtifacts: boolean): IssueEvent {
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
