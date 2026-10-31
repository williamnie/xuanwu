import type { RunnerDatabase } from "../database.ts";
import { lastInsertID } from "./intakeRunSupport.ts";
import {
  type IntakeRunInput,
  type IntakeRunRecord,
  normalizeRun,
  runInsertColumns,
  runInsertValues,
  getIntakeRun,
  type IntakeRunPatch,
  requireIntakeRun,
  type IntakeRunFilter,
  runListQuery,
  type SQLValue,
  RUN_COLUMNS,
  mapRun
} from "./intakeRunsModel.ts";

export function createIntakeRun(
  db: RunnerDatabase,
  input: IntakeRunInput,
  timestamp = new Date()
): IntakeRunRecord {
  const record = normalizeRun(input, timestamp);
  db.sqlite.run(`insert into intake_runs (${runInsertColumns()})
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, runInsertValues(record));
  const saved = getIntakeRun(db, lastInsertID(db));
  if (!saved) throw new Error("intake run missing after write");
  return saved;
}

export function updateIntakeRun(
  db: RunnerDatabase,
  id: number,
  patch: IntakeRunPatch,
  timestamp = new Date()
): IntakeRunRecord {
  const current = requireIntakeRun(db, id);
  const next = normalizeRun({ ...current, ...patch }, new Date(current.created_at));
  db.sqlite.run(`update intake_runs set model_policy_id=?, model=?,
    input_summary_json=?, schema_output_json=?, ignored_groups_json=?,
    error=?, status=?, updated_at=? where id=?`, [
    next.model_policy_id, next.model, next.input_summary_json,
    next.schema_output_json, next.ignored_groups_json, next.error,
    next.status, timestamp.toISOString(), id
  ]);
  return requireIntakeRun(db, id);
}

export function listIntakeRuns(db: RunnerDatabase, filter: IntakeRunFilter = {}): IntakeRunRecord[] {
  const query = runListQuery(filter);
  return db.sqlite.query<Record<string, unknown>, SQLValue[]>(
    `select ${RUN_COLUMNS} from intake_runs${query.where}
      order by updated_at desc, id desc limit ?`
  ).all(...query.args).map(mapRun);
}

export type { IntakeRunStatus } from "./intakeRunsModel.ts";
export type { IntakeRunRecord } from "./intakeRunsModel.ts";
export type { AttentionInboxItemInput } from "./intakeRunsModel.ts";
export type { AttentionInboxItemRecord } from "./intakeRunsModel.ts";
export type { AttentionInboxItemStatus } from "./intakeRunsModel.ts";
export { getIntakeRun } from "./intakeRunsModel.ts";
export { createAttentionInboxItem } from "./intakeRunsInbox.ts";
export { listAttentionInboxItems } from "./intakeRunsInbox.ts";
export { ATTENTION_INBOX_SEED_SQL } from "./intakeRunsInbox.ts";
export { listAttentionInboxProjectionItems } from "./intakeRunsInbox.ts";
export { ATTENTION_RELATED_INBOX_SQL } from "./intakeRunsInbox.ts";
export { listRelatedAttentionInboxItems } from "./intakeRunsInbox.ts";
export { getAttentionInboxItem } from "./intakeRunsModel.ts";
export { updateAttentionInboxItemStatus } from "./intakeRunsInbox.ts";
