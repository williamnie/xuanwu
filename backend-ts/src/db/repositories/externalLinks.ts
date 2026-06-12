import type { RunnerDatabase } from "../database.ts";
import { getExternalEvent } from "./externalEvents.ts";
import { getIssue } from "./issues.ts";

type SQLValue = number | string;
type FilterParts = { args: SQLValue[]; conditions: string[] };

export type ExternalLinkRecord = {
  conversation_id: string;
  created_at: string;
  external_event_id: number;
  external_id: string;
  external_type: string;
  id: number;
  issue_id: number;
  loop_run_id: string;
  project_id: string;
  relationship: string;
  source: string;
  updated_at: string;
};

export type ExternalLinkInput = Partial<Omit<ExternalLinkRecord, "created_at" | "id" | "updated_at">>;

export type ExternalLinkExternalFilter = {
  externalID?: string;
  externalType?: string;
  limit?: number;
  source?: string;
};

const COLUMNS = `id, external_event_id, source, external_id, external_type,
  project_id, issue_id, conversation_id, loop_run_id, relationship, created_at, updated_at`;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

export function createExternalLink(
  db: RunnerDatabase,
  input: ExternalLinkInput,
  timestamp = new Date()
): ExternalLinkRecord {
  const record = normalizeCreate(db, input, timestamp);
  db.sqlite.run(`insert or ignore into external_links (${insertColumns()})
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, insertValues(record));
  const saved = getExternalLinkByIdentity(db, record);
  if (!saved) throw new Error("external link missing after write");
  return saved;
}

export function listExternalLinksByIssue(db: RunnerDatabase, issueID: number): ExternalLinkRecord[] {
  if (!Number.isSafeInteger(issueID) || issueID <= 0) return [];
  return db.sqlite.query<Record<string, unknown>, [number]>(
    `select ${COLUMNS} from external_links where issue_id=? order by created_at desc, id desc`
  ).all(issueID).map(mapExternalLink);
}

export function listExternalLinksByExternal(
  db: RunnerDatabase,
  filter: ExternalLinkExternalFilter = {}
): ExternalLinkRecord[] {
  const query = externalFilter(filter);
  return db.sqlite.query<Record<string, unknown>, SQLValue[]>(
    `select ${COLUMNS} from external_links${query.where} order by created_at desc, id desc limit ?`
  ).all(...query.args).map(mapExternalLink);
}

function normalizeCreate(db: RunnerDatabase, input: ExternalLinkInput, timestamp: Date): ExternalLinkRecord {
  const event = externalEvent(db, input.external_event_id);
  const issue = linkedIssue(db, input.issue_id);
  const record = {
    id: 0,
    external_event_id: positiveInteger(input.external_event_id),
    source: cleanString(input.source) || event?.source || "",
    external_id: cleanString(input.external_id) || event?.external_id || "",
    external_type: cleanString(input.external_type),
    project_id: cleanString(input.project_id) || issue?.project_id || "",
    issue_id: positiveInteger(input.issue_id),
    conversation_id: cleanString(input.conversation_id),
    loop_run_id: cleanString(input.loop_run_id),
    relationship: cleanString(input.relationship) || "related",
    created_at: timestamp.toISOString(),
    updated_at: timestamp.toISOString()
  };
  validateLink(record, issue?.project_id ?? "");
  return record;
}

function externalEvent(db: RunnerDatabase, value: unknown): { external_id: string; source: string } | null {
  const id = positiveInteger(value);
  if (id === 0) return null;
  const event = getExternalEvent(db, id);
  if (!event) throw new Error("external event not found");
  return event;
}

function linkedIssue(db: RunnerDatabase, value: unknown): { project_id: string } | null {
  const id = positiveInteger(value);
  if (id === 0) return null;
  const issue = getIssue(db, id);
  if (!issue) throw new Error("issue not found");
  return issue;
}

function validateLink(record: ExternalLinkRecord, issueProjectID: string): void {
  if (record.source === "") throw new Error("source is required");
  if (record.external_event_id === 0 && record.external_id === "") throw new Error("external_id is required");
  if (!hasRunnerTarget(record)) throw new Error("runner target is required");
  if (issueProjectID !== "" && record.project_id !== issueProjectID) {
    throw new Error("project_id does not match issue_id");
  }
}

function hasRunnerTarget(record: ExternalLinkRecord): boolean {
  return record.project_id !== "" || record.issue_id > 0 ||
    record.conversation_id !== "" || record.loop_run_id !== "";
}

function getExternalLinkByIdentity(db: RunnerDatabase, record: ExternalLinkRecord): ExternalLinkRecord | null {
  const row = db.sqlite.query<Record<string, unknown>, SQLValue[]>(
    `select ${COLUMNS} from external_links where ${identityWhere()}`
  ).get(...identityValues(record));
  return row ? mapExternalLink(row) : null;
}

function externalFilter(filter: ExternalLinkExternalFilter): { args: SQLValue[]; where: string } {
  const query: FilterParts = { args: [], conditions: [] };
  addFilter(query, "source=?", cleanString(filter.source));
  addFilter(query, "external_id=?", cleanString(filter.externalID));
  addFilter(query, "external_type=?", cleanString(filter.externalType));
  query.args.push(listLimit(filter.limit));
  return {
    args: query.args,
    where: query.conditions.length > 0 ? ` where ${query.conditions.join(" and ")}` : ""
  };
}

function addFilter(query: FilterParts, condition: string, value: string): void {
  if (value === "") return;
  query.conditions.push(condition);
  query.args.push(value);
}

function mapExternalLink(row: Record<string, unknown>): ExternalLinkRecord {
  return {
    id: integerValue(row.id, "external_links.id"),
    external_event_id: integerValue(row.external_event_id, "external_links.external_event_id"),
    source: requiredString(row.source, "external_links.source"),
    external_id: optionalString(row.external_id),
    external_type: optionalString(row.external_type),
    project_id: optionalString(row.project_id),
    issue_id: integerValue(row.issue_id, "external_links.issue_id"),
    conversation_id: optionalString(row.conversation_id),
    loop_run_id: optionalString(row.loop_run_id),
    relationship: requiredString(row.relationship, "external_links.relationship"),
    created_at: requiredString(row.created_at, "external_links.created_at"),
    updated_at: requiredString(row.updated_at, "external_links.updated_at")
  };
}

function insertColumns(): string {
  return `external_event_id, source, external_id, external_type, project_id,
    issue_id, conversation_id, loop_run_id, relationship, created_at, updated_at`;
}

function insertValues(record: ExternalLinkRecord): SQLValue[] {
  return [
    record.external_event_id, record.source, record.external_id, record.external_type,
    record.project_id, record.issue_id, record.conversation_id, record.loop_run_id,
    record.relationship, record.created_at, record.updated_at
  ];
}

function identityWhere(): string {
  return `external_event_id=? and source=? and external_id=? and external_type=? and
    project_id=? and issue_id=? and conversation_id=? and loop_run_id=? and relationship=?`;
}

function identityValues(record: ExternalLinkRecord): SQLValue[] {
  return [
    record.external_event_id, record.source, record.external_id, record.external_type,
    record.project_id, record.issue_id, record.conversation_id, record.loop_run_id, record.relationship
  ];
}

function listLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(value, MAX_LIST_LIMIT);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new Error("expected string row value");
  return value.trim();
}

function requiredString(value: unknown, label: string): string {
  const text = optionalString(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}

function integerValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}
