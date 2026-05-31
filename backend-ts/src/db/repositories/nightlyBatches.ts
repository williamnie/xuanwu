import type { RunnerDatabase } from "../database.ts";
import { getIssue, type Issue } from "./issues.ts";

export type NightlyBatch = {
  created_at: string;
  current_issue_id: number;
  id: number;
  items: NightlyBatchItem[];
  pause_reason: string;
  policy: string;
  project_id: string;
  promotion_mode: string;
  status: string;
  updated_at: string;
};

export type NightlyBatchItem = {
  batch_id: number;
  issue?: Issue;
  issue_id: number;
  position: number;
  status: string;
  updated_at: string;
};

type NightlyBatchRow = Omit<NightlyBatch, "items">;
type NightlyBatchItemRow = Omit<NightlyBatchItem, "issue">;

const BATCH_COLUMNS = `id, project_id, policy, promotion_mode, status,
  current_issue_id, pause_reason, created_at, updated_at`;

export function listNightlyBatches(db: RunnerDatabase, projectID = ""): NightlyBatch[] {
  const filter = projectID.trim();
  const query = filter === ""
    ? { sql: `select ${BATCH_COLUMNS} from nightly_batches order by id desc`, args: [] as string[] }
    : { sql: `select ${BATCH_COLUMNS} from nightly_batches where project_id=? order by id desc`, args: [filter] };
  return db.sqlite.query<NightlyBatchRow, string[]>(query.sql).all(...query.args).map((row) => ({
    ...mapNightlyBatchRow(row),
    items: listNightlyBatchItems(db, positiveInteger(row.id, "nightly_batches.id"))
  }));
}

function listNightlyBatchItems(db: RunnerDatabase, batchID: number): NightlyBatchItem[] {
  return db.sqlite.query<NightlyBatchItemRow, [number]>(`
    select batch_id, issue_id, position, status, updated_at
    from nightly_batch_items where batch_id=? order by position asc
  `).all(batchID).map((row) => {
    const item = mapNightlyBatchItemRow(row);
    const issue = getIssue(db, item.issue_id);
    return issue ? { ...item, issue } : item;
  });
}

function mapNightlyBatchRow(row: NightlyBatchRow): Omit<NightlyBatch, "items"> {
  return {
    id: positiveInteger(row.id, "nightly_batches.id"),
    project_id: requiredString(row.project_id, "nightly_batches.project_id"),
    policy: requiredString(row.policy, "nightly_batches.policy"),
    promotion_mode: requiredString(row.promotion_mode, "nightly_batches.promotion_mode"),
    status: requiredString(row.status, "nightly_batches.status"),
    current_issue_id: integerValue(row.current_issue_id, "nightly_batches.current_issue_id"),
    pause_reason: optionalString(row.pause_reason),
    created_at: requiredString(row.created_at, "nightly_batches.created_at"),
    updated_at: requiredString(row.updated_at, "nightly_batches.updated_at")
  };
}

function mapNightlyBatchItemRow(row: NightlyBatchItemRow): NightlyBatchItem {
  return {
    batch_id: positiveInteger(row.batch_id, "nightly_batch_items.batch_id"),
    issue_id: positiveInteger(row.issue_id, "nightly_batch_items.issue_id"),
    position: positiveInteger(row.position, "nightly_batch_items.position"),
    status: requiredString(row.status, "nightly_batch_items.status"),
    updated_at: requiredString(row.updated_at, "nightly_batch_items.updated_at")
  };
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

function positiveInteger(value: unknown, label: string): number {
  const number = integerValue(value, label);
  if (number <= 0) throw new Error(`${label} must be positive`);
  return number;
}

function integerValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}
