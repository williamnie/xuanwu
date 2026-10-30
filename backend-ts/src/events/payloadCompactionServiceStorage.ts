import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { quickCheck, recordMaintenanceAudit } from "../db/repositories/eventMaintenance.ts";
import { type IssueLogPayloadExternalizationPlan } from "../db/repositories/issueEvents.ts";
import {
  type PayloadRow,
  type PayloadCheckpoint,
  ISSUE_LOG_COMPACTION_SCHEMA_VERSION,
  ascendingPositiveEventIDs,
  sameEventIDs,
  type MaintenanceActor
} from "./payloadCompactionServiceModel.ts";

export function updatePayloadBatch(
  sqlite: Database,
  rows: Array<{ id: number; plan: IssueLogPayloadExternalizationPlan }>
): void {
  const update = sqlite.query("update issue_events set payload=? where id=? and type='issue.log' and payload=?");
  const apply = sqlite.transaction((items: typeof rows) => {
    for (const item of items) {
      const result = update.run(item.plan.stored_payload, item.id, item.plan.original_payload);
      if (Number(result.changes) !== 1) throw new Error(`issue_events:${item.id} compaction compare-and-set failed`);
    }
  });
  apply.immediate(rows);
}

export function restorePayloadBatch(
  sqlite: Database,
  rows: Array<{ id: number; original: string; stored: string }>
): void {
  const update = sqlite.query("update issue_events set payload=? where id=? and type='issue.log' and payload=?");
  const restore = sqlite.transaction((items: typeof rows) => {
    for (const item of items) {
      const result = update.run(item.original, item.id, item.stored);
      if (Number(result.changes) !== 1) throw new Error(`issue_events:${item.id} restore compare-and-set failed`);
    }
  });
  restore.immediate(rows);
}

export function payloadRows(sqlite: Database, ids: number[]): PayloadRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return sqlite.query<PayloadRow, number[]>(`
    select id, payload from issue_events where id in (${placeholders}) order by id asc
  `).all(...ids);
}

export function readCheckpoint(path: string, operation: PayloadCheckpoint["operation"]): PayloadCheckpoint {
  const value = JSON.parse(readFileSync(resolve(path), "utf8")) as PayloadCheckpoint;
  if (value.schema_version !== ISSUE_LOG_COMPACTION_SCHEMA_VERSION || value.operation !== operation ||
    !Array.isArray(value.event_ids) || !Number.isSafeInteger(value.cursor) || value.cursor < 0 ||
    value.cursor > value.event_ids.length || !ascendingPositiveEventIDs(value.event_ids) ||
    !sameEventIDs(value.event_ids, value.plan?.event_ids ?? [])) {
    throw new Error(`invalid ${operation} checkpoint`);
  }
  return value;
}

export function openDatabase(path: string, writable: boolean): Database {
  const sqlite = new Database(path, writable
    ? { readwrite: true, strict: true }
    : { readonly: true, strict: true });
  sqlite.run("pragma foreign_keys = on");
  return sqlite;
}

export function existingDatabasePath(value: string): string {
  const path = resolve(value);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`database does not exist: ${path}`);
  return path;
}

export function requireWriteAuthorization(
  actor: MaintenanceActor | undefined,
  confirmBackupTested: boolean | undefined,
  confirmNoActiveWriters: boolean | undefined
): void {
  if (!actor?.actor.trim() || !actor.auditRef.trim() || !actor.reason.trim()) {
    throw new Error("applied payload compaction requires actor, audit ref, and reason");
  }
  if (!confirmBackupTested) throw new Error("--confirm-backup-tested is required with --apply");
  if (!confirmNoActiveWriters) throw new Error("--confirm-no-active-writers is required with --apply");
}

export function audit(sqlite: Database, actor: MaintenanceActor, eventType: string, result: Record<string, unknown>): void {
  recordMaintenanceAudit(sqlite, {
    actionID: actor.auditRef,
    actor: actor.actor,
    decision: "allow",
    eventType,
    reason: actor.reason,
    result
  });
}

export function saveJSON(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function writeJSON(path: string, value: unknown): void {
  saveJSON(path, value);
}

export function quickCheckPath(path: string): string {
  const sqlite = openDatabase(path, false);
  try {
    return quickCheck(sqlite);
  } finally {
    sqlite.close();
  }
}
