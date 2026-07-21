import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { recordMaintenanceAudit } from "./repositories/eventMaintenance.ts";
import { WAL_AUTOCHECKPOINT_PAGES } from "./database.ts";

export const WAL_MAINTENANCE_SCHEMA = "xuanwu.sqlite-wal-maintenance.v1" as const;
export const WAL_REQUIRED_ACTOR = "xiaobei";
export const WAL_REQUIRED_AUDIT_REF = "issue-773-user-request-2026-07-21";
export const WAL_REQUIRED_REASON = "用户要求完成性能优化";

type WalOperation = "apply" | "dry-run" | "rollback" | "verify";

export type WalMaintenanceInput = {
  actor?: string;
  actorKind?: "automation" | "system" | "user";
  apply?: boolean;
  auditRef?: string;
  availableBytesForTest?: number;
  confirmBackupTested?: boolean;
  confirmNoActiveWriters?: boolean;
  dbPath: string;
  operation: WalOperation;
  reason?: string;
  reportPath: string;
};

export function runWalMaintenance(input: WalMaintenanceInput): Record<string, unknown> {
  const dbPath = required(input.dbPath, "--db");
  const reportPath = required(input.reportPath, "--report");
  assertDistinct(dbPath, reportPath);
  if (input.operation === "dry-run" || input.operation === "verify") {
    const db = open(dbPath, true);
    try {
      const report = inspectionReport(db, input, input.operation, input.operation === "verify" ? "verified" : "checked");
      if (input.operation === "verify" && journalMode(db) !== "wal") {
        throw reportFailure(reportPath, report, "journal_mode is not wal");
      }
      writeReport(reportPath, report);
      return report;
    } finally {
      db.close();
    }
  }

  if (!input.apply) throw new Error("--apply is required for WAL apply or rollback");
  const authorization = authorize(input);
  requireConfirmations(input);
  const db = open(dbPath, false);
  try {
    assertNoCompetingWriter(db);
    const before = inspectionReport(db, input, input.operation, "before");
    if (String((before.database as Record<string, unknown>).quick_check) !== "ok") {
      throw reportFailure(reportPath, before, "quick_check failed before journal transition");
    }
    if (input.operation === "apply") assertDiskHeadroom(input, dbPath);
    const targetMode = input.operation === "apply" ? "wal" : "delete";
    if (input.operation === "rollback") checkpoint(db, "truncate");
    const actualMode = String(db.query<Record<string, unknown>, []>(`pragma journal_mode=${targetMode}`).get()?.journal_mode ?? "").toLowerCase();
    if (actualMode !== targetMode) throw new Error(`journal_mode transition failed: expected ${targetMode}, got ${actualMode}`);
    if (targetMode === "wal") {
      db.run("pragma synchronous=normal");
      db.run(`pragma wal_autocheckpoint=${WAL_AUTOCHECKPOINT_PAGES}`);
    } else {
      db.run("pragma synchronous=full");
    }
    const after = inspectionReport(db, input, input.operation, "applied");
    recordMaintenanceAudit(db, {
      actionID: `sqlite-wal:${input.operation}:${crypto.randomUUID()}`,
      actor: authorization.actor,
      decision: "allow",
      eventType: `sqlite_wal.${input.operation}_completed`,
      reason: authorization.reason,
      result: {
        actor_kind: authorization.actorKind,
        audit_ref: authorization.auditRef,
        before,
        journal_mode: targetMode,
        schema_version: WAL_MAINTENANCE_SCHEMA
      }
    });
    const checkpointResult = targetMode === "wal" ? checkpoint(db, "passive") : null;
    const report = {
      ...after,
      audit: authorization,
      before,
      checkpoint: checkpointResult,
      rollback: rollbackContract(dbPath, reportPath)
    };
    writeReport(reportPath, report);
    return report;
  } catch (error) {
    const failure = inspectionReport(db, input, input.operation, "failed", errorMessage(error));
    writeReport(reportPath, failure);
    throw error;
  } finally {
    db.close();
  }
}

function inspectionReport(
  db: Database,
  input: WalMaintenanceInput,
  operation: WalOperation,
  outcome: string,
  error = ""
): Record<string, unknown> {
  const mode = journalMode(db);
  const dbPath = resolve(input.dbPath);
  const databaseBytes = statSync(dbPath).size;
  const availableBytes = input.availableBytesForTest ?? Number(statfsSync(dirname(dbPath)).bavail) * Number(statfsSync(dirname(dbPath)).bsize);
  return {
    schema_version: WAL_MAINTENANCE_SCHEMA,
    operation: `sqlite-wal-${operation}`,
    outcome,
    dry_run: operation === "dry-run" || operation === "verify",
    generated_at: new Date().toISOString(),
    database: {
      path: dbPath,
      bytes: databaseBytes,
      quick_check: scalar(db, "pragma quick_check"),
      foreign_key_check: db.query("pragma foreign_key_check").all().length === 0 ? "ok" : "failed",
      journal_mode: mode,
      synchronous: Number(scalar(db, "pragma synchronous")),
      wal_autocheckpoint: Number(scalar(db, "pragma wal_autocheckpoint")),
      row_counts: authorityRowCounts(db)
    },
    disk: {
      available_bytes: availableBytes,
      required_bytes: requiredHeadroom(databaseBytes),
      sufficient: availableBytes >= requiredHeadroom(databaseBytes)
    },
    sidecars: sidecars(dbPath),
    snapshot_strategy: "use SQLite VACUUM INTO/backup API while quiesced or a verified backup bundle; never copy runner.db alone while WAL is active",
    writer_gate: {
      confirmed_backup_tested: Boolean(input.confirmBackupTested),
      confirmed_no_active_writers: Boolean(input.confirmNoActiveWriters)
    },
    ...(error ? { error: error.slice(0, 240) } : {})
  };
}

function authorize(input: WalMaintenanceInput) {
  const actor = required(input.actor, "--actor");
  const auditRef = required(input.auditRef, "--audit-ref");
  const reason = required(input.reason, "--reason");
  if (input.actorKind !== "user") throw new Error("WAL apply requires --actor-kind user");
  if (actor !== WAL_REQUIRED_ACTOR) throw new Error(`WAL apply requires --actor ${WAL_REQUIRED_ACTOR}`);
  if (auditRef !== WAL_REQUIRED_AUDIT_REF) throw new Error(`WAL apply requires --audit-ref ${WAL_REQUIRED_AUDIT_REF}`);
  if (reason !== WAL_REQUIRED_REASON) throw new Error(`WAL apply requires --reason ${WAL_REQUIRED_REASON}`);
  return { actor, actorKind: input.actorKind, auditRef, reason };
}

function requireConfirmations(input: WalMaintenanceInput): void {
  if (!input.confirmBackupTested) throw new Error("--confirm-backup-tested is required for apply mode");
  if (!input.confirmNoActiveWriters) throw new Error("--confirm-no-active-writers is required for apply mode");
}

function assertNoCompetingWriter(db: Database): void {
  db.run("begin immediate");
  db.run("rollback");
}

function assertDiskHeadroom(input: WalMaintenanceInput, path: string): void {
  const size = statSync(path).size;
  const stats = statfsSync(dirname(path));
  const available = input.availableBytesForTest ?? Number(stats.bavail) * Number(stats.bsize);
  const requiredBytes = requiredHeadroom(size);
  if (available < requiredBytes) throw new Error(`insufficient disk headroom for WAL: required ${requiredBytes}, available ${available}`);
}

function requiredHeadroom(databaseBytes: number): number {
  return Math.max(256 * 1024 * 1024, databaseBytes);
}

function checkpoint(db: Database, mode: "passive" | "truncate"): Record<string, number> {
  const row = db.query<Record<string, unknown>, []>(`pragma wal_checkpoint(${mode})`).get() ?? {};
  return {
    busy: Number(row.busy ?? 0),
    checkpointed: Number(row.checkpointed ?? 0),
    log: Number(row.log ?? 0)
  };
}

function authorityRowCounts(db: Database): Record<string, number> {
  return Object.fromEntries(["issues", "issue_runs", "run_attempts", "issue_events"].map((table) => [
    table,
    Number(db.query<{ count: number }, []>(`select count(*) as count from ${table}`).get()?.count ?? 0)
  ]));
}

function sidecars(path: string): Record<string, unknown> {
  return Object.fromEntries(["wal", "shm"].map((suffix) => {
    const sidecar = `${path}-${suffix}`;
    return [suffix, { exists: existsSync(sidecar), bytes: existsSync(sidecar) ? statSync(sidecar).size : 0 }];
  }));
}

function rollbackContract(dbPath: string, reportPath: string): Record<string, string> {
  return {
    command: `codex-issue-runner maintenance db wal --operation rollback --db ${shellPlaceholder(dbPath)} --report ${shellPlaceholder(reportPath)} --apply --confirm-backup-tested --confirm-no-active-writers --actor ${WAL_REQUIRED_ACTOR} --actor-kind user --audit-ref ${WAL_REQUIRED_AUDIT_REF} --reason '${WAL_REQUIRED_REASON}'`,
    restore: "if integrity or row-count verification fails, keep Core stopped and restore the verified backup bundle into a fresh state directory"
  };
}

function open(path: string, readonly: boolean): Database {
  const db = new Database(path, { create: false, readonly, readwrite: !readonly, strict: true });
  db.run("pragma busy_timeout=50");
  db.run("pragma foreign_keys=on");
  if (readonly) db.run("pragma query_only=on");
  if (journalMode(db) === "wal") {
    db.run("pragma synchronous=normal");
    db.run(`pragma wal_autocheckpoint=${WAL_AUTOCHECKPOINT_PAGES}`);
  }
  return db;
}

function journalMode(db: Database): string {
  return String(db.query<Record<string, unknown>, []>("pragma journal_mode").get()?.journal_mode ?? "").toLowerCase();
}

function scalar(db: Database, sql: string): string {
  const row = db.query<Record<string, unknown>, []>(sql).get() ?? {};
  return String(Object.values(row)[0] ?? "");
}

function writeReport(path: string, report: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.partial-${crypto.randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function reportFailure(path: string, report: Record<string, unknown>, message: string): Error {
  writeReport(path, { ...report, outcome: "failed", error: message });
  return new Error(message);
}

function assertDistinct(...paths: string[]): void {
  if (new Set(paths.map((path) => resolve(path))).size !== paths.length) throw new Error("database and report paths must be different");
}

function required(value: string | undefined, flag: string): string {
  const clean = value?.trim() ?? "";
  if (!clean) throw new Error(`${flag} is required`);
  return clean;
}

function shellPlaceholder(path: string): string {
  return path.includes(" ") ? "<path>" : path;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
