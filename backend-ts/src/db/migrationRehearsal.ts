import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { recordMaintenanceAudit } from "./repositories/eventMaintenance.ts";
import { runMigrations, type SqlMigration } from "./migrations.ts";
import { migrations as currentMigrations } from "./schema/index.ts";

export const STORAGE_COMPAT_VERSION = "xuanwu.storage-compat.v1" as const;
export const MIGRATION_REHEARSAL_REPORT_SCHEMA_VERSION = "xuanwu.db-migration-rehearsal-report.v1" as const;

type Authorization = {
  actor: string;
  actorKind: "automation" | "system" | "user";
  auditRef: string;
  reason: string;
};

export type MigrationRehearsalInput = {
  actor?: string;
  actorKind?: "automation" | "system" | "user";
  apply?: boolean;
  auditRef?: string;
  backupPath?: string;
  compatVersion?: string;
  confirmBackupTested?: boolean;
  confirmNoActiveWriters?: boolean;
  dbPath: string;
  migrations?: SqlMigration[];
  reason?: string;
  reportPath: string;
};

export function preflightDatabaseMigration(input: MigrationRehearsalInput): Record<string, unknown> {
  const db = open(input.dbPath, true);
  try {
    const report = reportFor("preflight", db, input, undefined, undefined);
    writeReport(input.reportPath, report);
    return report;
  } finally {
    db.close();
  }
}

export function forwardDatabaseMigration(input: MigrationRehearsalInput): Record<string, unknown> {
  if (!input.apply) return preflightDatabaseMigration(input);
  const authorization = authorize(input);
  const backupPath = required(input.backupPath, "--backup");
  requireWriteConfirmations(input);
  assertCompatibleVersion(input.compatVersion);
  const db = open(input.dbPath, false);
  try {
    assertPathsDistinct(input.dbPath, backupPath, input.reportPath);
    createBackup(db, backupPath);
    const before = reportFor("forward", db, input, backupPath, "before_forward");
    try {
      runMigrations(db, input.migrations ?? currentMigrations);
      const report = reportFor("forward", db, input, backupPath, "applied", before);
      recordAudit(db, authorization, "db_migration.forward_completed", "allow", report);
      writeReport(input.reportPath, report);
      return report;
    } catch (error) {
      const report = reportFor("forward", db, input, backupPath, "failed", before, errorMessage(error));
      try {
        recordAudit(db, authorization, "db_migration.forward_failed", "deny", report);
      } catch {
        // The original migration failure is decisive; a legacy pre-audit database may not have the audit sink yet.
      }
      writeReport(input.reportPath, report);
      throw error;
    }
  } finally {
    db.close();
  }
}

export function rollbackDatabaseMigration(input: MigrationRehearsalInput): Record<string, unknown> {
  if (!input.apply) return preflightDatabaseMigration(input);
  const authorization = authorize(input);
  const backupPath = required(input.backupPath, "--backup");
  requireWriteConfirmations(input);
  assertCompatibleVersion(input.compatVersion);
  assertPathsDistinct(input.dbPath, backupPath, input.reportPath);
  if (!existsSync(backupPath)) throw new Error(`backup does not exist: ${backupPath}`);
  const backupHash = sha256File(backupPath);
  copyFileSync(backupPath, input.dbPath);
  const db = open(input.dbPath, false);
  try {
    const report = reportFor("rollback", db, input, backupPath, "restored");
    recordAudit(db, authorization, "db_migration.rollback_completed", "allow", {
      backup_sha256: backupHash,
      ...report
    });
    writeReport(input.reportPath, report);
    return report;
  } finally {
    db.close();
  }
}

function reportFor(
  operation: "preflight" | "forward" | "rollback",
  db: Database,
  input: MigrationRehearsalInput,
  backupPath: string | undefined,
  outcome: "before_forward" | "applied" | "failed" | "restored" | undefined,
  before?: Record<string, unknown>,
  error?: string
): Record<string, unknown> {
  const migrations = migrationIDs(db);
  const health = healthGate(db, input.compatVersion);
  return {
    schema_version: MIGRATION_REHEARSAL_REPORT_SCHEMA_VERSION,
    operation,
    outcome: outcome ?? "checked",
    generated_at: new Date().toISOString(),
    database: {
      path: resolve(input.dbPath),
      sha256: sha256File(input.dbPath),
      quick_check: scalar(db, "pragma quick_check"),
      foreign_key_check: db.query("pragma foreign_key_check").all().length === 0 ? "ok" : "failed",
      schema_migrations: migrations
    },
    backup: backupPath ? { path: resolve(backupPath), sha256: existsSync(backupPath) ? sha256File(backupPath) : "" } : null,
    compatibility: compatibilityGate(input.compatVersion),
    health_gate: health,
    rollback: {
      command: "maintenance db migration-rollback --db <rehearsal-copy.db> --backup <fresh-backup.db> --report <report.json> --apply --confirm-backup-tested --confirm-no-active-writers --actor <non-llm> --actor-kind user|system|automation --audit-ref <ref> --reason <reason>",
      scope: "restore the rehearsal copy from its fresh pre-forward SQLite backup; no table drop is permitted"
    },
    ...(before ? { before } : {}),
    ...(error ? { error } : {})
  };
}

function healthGate(db: Database, compatVersion: string | undefined): Record<string, unknown> {
  const applied = new Set(migrationIDs(db));
  const work = streamGate(db, {
    id: "work",
    legacyTables: ["issues", "issue_events"],
    migrationID: "041_work_ledger_schema",
    targetTables: ["works", "work_relations", "work_events"],
    sourceOfTruth: "issues and issue_events remain authoritative during W0-W2",
    targetRole: "shadow/projection until its declared cutover gate"
  });
  const run = streamGate(db, {
    id: "run",
    legacyTables: ["issue_runs", "agent_sessions"],
    migrationID: "042_run_attempt_relations",
    targetTables: ["run_attempts"],
    sourceOfTruth: "issue_runs and agent_sessions remain authoritative during W0-W2",
    targetRole: "compatibility relation/projection until its declared cutover gate"
  });
  const deferred = [
    deferredStream("evidence", "issue_events and deterministic verification state", "No Evidence storage migration exists yet; P10.02 must not invent a parallel table."),
    deferredStream("handoff", "issue_events and Git/Evidence references", "No Handoff storage migration exists yet; P10.02 must not invent a parallel table.")
  ];
  const schemaReady = work.ready && run.ready;
  return {
    status: schemaReady && compatibilityGate(compatVersion).status === "compatible" ? "passed" : "blocked",
    checks: {
      quick_check: scalar(db, "pragma quick_check") === "ok",
      foreign_key_check: db.query("pragma foreign_key_check").all().length === 0,
      compatibility: compatibilityGate(compatVersion).status === "compatible",
      required_schema_migrations: ["041_work_ledger_schema", "042_run_attempt_relations"].every((id) => applied.has(id))
    },
    streams: [work, run, ...deferred],
    cutover: "blocked: this rehearsal validates only additive schema and rollback. Backfill/parity and P11/G7 remain separate deterministic gates.",
    destructive_operations: "denied: P10.02 never drops legacy tables, indexes, routes, or compatibility code."
  };
}

function streamGate(db: Database, stream: {
  id: string;
  legacyTables: string[];
  migrationID: string;
  sourceOfTruth: string;
  targetRole: string;
  targetTables: string[];
}): Record<string, unknown> & { ready: boolean } {
  const missingTables = [...stream.legacyTables, ...stream.targetTables].filter((table) => !hasTable(db, table));
  const migrationApplied = migrationIDs(db).includes(stream.migrationID);
  return {
    id: stream.id,
    status: migrationApplied && missingTables.length === 0 ? "ready_for_compat_rehearsal" : "blocked",
    ready: migrationApplied && missingTables.length === 0,
    source_of_truth: stream.sourceOfTruth,
    target_role: stream.targetRole,
    migration_id: stream.migrationID,
    legacy_tables: stream.legacyTables,
    target_tables: stream.targetTables,
    counts: Object.fromEntries([...stream.legacyTables, ...stream.targetTables].map((table) => [table, hasTable(db, table) ? countRows(db, table) : null])),
    ...(missingTables.length === 0 ? {} : { missing_tables: missingTables })
  };
}

function deferredStream(id: string, sourceOfTruth: string, reason: string): Record<string, unknown> {
  return {
    id,
    status: "deferred_without_target_storage",
    source_of_truth: sourceOfTruth,
    target_role: "not_created",
    reason,
    forward_migration: "blocked until a later issue defines an additive schema, mapping, dual-read window, rollback and P11 delete gate"
  };
}

function compatibilityGate(actual: string | undefined): Record<string, string> {
  const received = actual?.trim() || STORAGE_COMPAT_VERSION;
  if (received === STORAGE_COMPAT_VERSION) return { status: "compatible", expected: STORAGE_COMPAT_VERSION, received };
  return {
    status: "blocked",
    expected: STORAGE_COMPAT_VERSION,
    received,
    reason: `compatibility downgrade or mismatch: runtime ${received} cannot operate storage gate ${STORAGE_COMPAT_VERSION}`
  };
}

function assertCompatibleVersion(version: string | undefined): void {
  const gate = compatibilityGate(version);
  if (gate.status !== "compatible") throw new Error(gate.reason);
}

function createBackup(db: Database, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) throw new Error(`backup already exists: ${path}`);
  db.run("vacuum main into ?", [path]);
  const backup = open(path, true);
  try {
    if (scalar(backup, "pragma quick_check") !== "ok") throw new Error("backup quick_check failed");
  } finally {
    backup.close();
  }
}

function authorize(input: MigrationRehearsalInput): Authorization {
  const actor = required(input.actor, "--actor");
  if (actor.toLowerCase() === "llm") throw new Error("--actor cannot be llm");
  const actorKind = input.actorKind;
  if (actorKind !== "automation" && actorKind !== "system" && actorKind !== "user") {
    throw new Error("--actor-kind must be user, system, or automation");
  }
  return { actor, actorKind, auditRef: required(input.auditRef, "--audit-ref"), reason: required(input.reason, "--reason") };
}

function requireWriteConfirmations(input: MigrationRehearsalInput): void {
  if (!input.confirmBackupTested) throw new Error("--confirm-backup-tested is required for apply mode");
  if (!input.confirmNoActiveWriters) throw new Error("--confirm-no-active-writers is required for apply mode");
}

function recordAudit(db: Database, authorization: Authorization, eventType: string, decision: string, result: Record<string, unknown>): void {
  recordMaintenanceAudit(db, {
    actionID: `db-migration:${crypto.randomUUID()}`,
    actor: authorization.actor,
    decision,
    eventType,
    reason: authorization.reason,
    result: { actor_kind: authorization.actorKind, audit_ref: authorization.auditRef, ...result }
  });
}

function open(path: string, readonly: boolean): Database {
  const db = new Database(path, { readonly, readwrite: !readonly, strict: true });
  db.run("pragma foreign_keys = on");
  return db;
}

function migrationIDs(db: Database): string[] {
  return hasTable(db, "schema_migrations")
    ? db.query<{ id: string }, []>("select id from schema_migrations order by id").all().map((row) => row.id)
    : [];
}

function hasTable(db: Database, table: string): boolean {
  return Boolean(db.query<{ name: string }, [string]>("select name from sqlite_master where type='table' and name=?").get(table));
}

function countRows(db: Database, table: string): number {
  return db.query<{ count: number }, []>(`select count(*) as count from ${table}`).get()?.count ?? 0;
}

function scalar(db: Database, sql: string): string {
  const row = db.query<Record<string, unknown>, []>(sql).get() ?? {};
  return String(Object.values(row)[0] ?? "");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeReport(path: string, report: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function assertPathsDistinct(...paths: string[]): void {
  if (new Set(paths.map((path) => resolve(path))).size !== paths.length) {
    throw new Error("database, backup, and report paths must be different");
  }
}

function required(value: string | undefined, flag: string): string {
  const clean = value?.trim() ?? "";
  if (!clean) throw new Error(`${flag} is required`);
  return clean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
