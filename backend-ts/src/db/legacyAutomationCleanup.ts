import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { auditAutomationConsolidation } from "../domain/automation/consolidationAudit.ts";
import { recordMaintenanceAudit } from "./repositories/eventMaintenance.ts";
import {
  dropLegacyAutomationTables,
  LEGACY_AUTOMATION_DROP_MIGRATION_ID,
  LEGACY_AUTOMATION_DROP_TABLES
} from "./schema/053_drop_legacy_automation_tables.ts";

export const LEGACY_AUTOMATION_ARCHIVE_CONTRACT = "xw.legacy-automation-archive.v1";
export const LEGACY_AUTOMATION_CLEANUP_REPORT_CONTRACT = "xw.legacy-automation-cleanup-report.v1";

type Authorization = {
  actor: string;
  actorKind: "automation" | "system" | "user";
  auditRef: string;
  reason: string;
};

export type LegacyAutomationCleanupInput = {
  actor?: string;
  actorKind?: Authorization["actorKind"];
  apply?: boolean;
  archivePath?: string;
  auditRef?: string;
  backupPath?: string;
  confirmBackupTested?: boolean;
  confirmNoActiveWriters?: boolean;
  confirmTables?: string;
  dbPath: string;
  reason?: string;
  releaseRef?: string;
  reportPath: string;
  sourceRoot?: string;
};

export function cleanupLegacyAutomationSchema(input: LegacyAutomationCleanupInput): Record<string, unknown> {
  const dbPath = resolveRequired(input.dbPath, "--db");
  const reportPath = resolveRequired(input.reportPath, "--report");
  assertDistinct(dbPath, reportPath);
  const sourceRoot = resolve(input.sourceRoot ?? process.cwd());
  const beforeBytes = statSync(dbPath).size;
  const sqlite = open(dbPath, !input.apply);
  try {
    const inventory = inventoryFor(sqlite);
    const archiveCandidate = archivePayload(sqlite, dbPath, inventory);
    const gate = cleanupGate(dbPath, sourceRoot, input.releaseRef);
    const preflight = baseReport(dbPath, beforeBytes, inventory, archiveCandidate, gate, input.apply ? "apply" : "preflight");
    if (!input.apply) {
      writeJSON(reportPath, preflight);
      return preflight;
    }

    const authorization = authorize(input);
    requireConfirmations(input);
    requireExactTables(input.confirmTables);
    if (!gate.passed) throw new Error(`legacy Automation drop blocked: ${gate.blockers.join("; ")}`);
    const backupPath = resolveRequired(input.backupPath, "--backup");
    const archivePath = resolveRequired(input.archivePath, "--archive");
    assertDistinct(dbPath, reportPath, backupPath, archivePath);
    if (existsSync(backupPath)) throw new Error(`backup already exists: ${backupPath}`);
    if (existsSync(archivePath)) throw new Error(`archive already exists: ${archivePath}`);

    const backup = createVerifiedBackup(sqlite, backupPath, archiveContentChecksum(archiveCandidate.payload));
    const archive = writeAndVerifyArchive(archivePath, archiveCandidate);
    const actionID = `legacy-automation-drop:${randomUUID()}`;
    const auditPayload = {
      actor_kind: authorization.actorKind,
      archive_path: archivePath,
      archive_sha256: archive.archive_sha256,
      audit_ref: authorization.auditRef,
      backup_path: backupPath,
      backup_sha256: backup.sha256,
      release_ref: clean(input.releaseRef),
      tables: [...LEGACY_AUTOMATION_DROP_TABLES]
    };
    const apply = sqlite.transaction(() => {
      recordMaintenanceAudit(sqlite, {
        actionID,
        actor: authorization.actor,
        decision: "allow",
        eventType: "db.legacy_automation_drop_started",
        reason: authorization.reason,
        result: auditPayload
      });
      dropLegacyAutomationTables(sqlite);
      sqlite.run("insert or ignore into schema_migrations (id) values (?)", [LEGACY_AUTOMATION_DROP_MIGRATION_ID]);
    });
    apply.immediate();
    sqlite.run("vacuum");
    const health = databaseHealth(sqlite);
    const remaining = LEGACY_AUTOMATION_DROP_TABLES.filter((table) => tableExists(sqlite, table));
    if (remaining.length > 0 || health.quick_check !== "ok" || health.foreign_key_violations !== 0) {
      throw new Error(`post-drop validation failed: remaining=${remaining.join(",") || "none"}, quick_check=${health.quick_check}, foreign_keys=${health.foreign_key_violations}`);
    }
    const afterBytes = statSync(dbPath).size;
    const report = {
      ...preflight,
      outcome: "applied",
      archive,
      backup,
      audit: { action_id: actionID, ...auditPayload },
      database: { ...health, sha256: sha256File(dbPath) },
      file_size: {
        after_bytes: afterBytes,
        before_bytes: beforeBytes,
        delta_bytes: afterBytes - beforeBytes,
        reclaimed_bytes: Math.max(0, beforeBytes - afterBytes)
      },
      removed_indexes: inventory.indexes.map((index) => index.name),
      removed_tables: [...LEGACY_AUTOMATION_DROP_TABLES],
      rollback: rollbackLimit(backupPath)
    };
    recordMaintenanceAudit(sqlite, {
      actionID,
      actor: authorization.actor,
      decision: "allow",
      eventType: "db.legacy_automation_drop_completed",
      reason: authorization.reason,
      result: report
    });
    writeJSON(reportPath, report);
    return report;
  } catch (error) {
    const failure = {
      contract: LEGACY_AUTOMATION_CLEANUP_REPORT_CONTRACT,
      database_path: dbPath,
      error: errorMessage(error),
      generated_at: new Date().toISOString(),
      operation: input.apply ? "apply" : "preflight",
      outcome: "blocked"
    };
    writeJSON(reportPath, failure);
    throw error;
  } finally {
    sqlite.close();
  }
}

export function verifyLegacyAutomationArchive(path: string): Record<string, unknown> {
  const archivePath = resolveRequired(path, "--archive");
  const archive = JSON.parse(readFileSync(archivePath, "utf8")) as {
    archive_sha256?: string;
    contract?: string;
    payload?: Record<string, unknown>;
  };
  if (archive.contract !== LEGACY_AUTOMATION_ARCHIVE_CONTRACT || !archive.payload) {
    throw new Error("unsupported legacy Automation archive contract");
  }
  const actual = sha256(stableJSON(archive.payload));
  if (!archive.archive_sha256 || archive.archive_sha256 !== actual) {
    throw new Error("legacy Automation archive checksum failed");
  }
  return { archive: archivePath, archive_sha256: actual, contract: archive.contract, verified: true };
}

function cleanupGate(dbPath: string, sourceRoot: string, releaseRef: string | undefined) {
  const root = mkdtempSync(`${tmpdir()}/xw-p11-09-audit-`);
  try {
    const consolidation = auditAutomationConsolidation({
      dbPath,
      reportPath: resolve(root, "automation-consolidation.json"),
      sourceRoot
    }) as Record<string, any>;
    const exactConsumers = exactSourceConsumerAudit(sourceRoot);
    const release = {
      passed: clean(releaseRef) !== "" && consolidation.consumer_zero?.compatibility_usage_since_cutover === 0,
      ref: clean(releaseRef),
      usage_since_cutover: consolidation.consumer_zero?.compatibility_usage_since_cutover ?? null
    };
    const blockers = [
      consolidation.data_gate?.passed ? "" : "Automation data gate is not passed",
      consolidation.parity_gate?.passed ? "" : "Automation parity gate is not passed",
      consolidation.cutover_gate?.passed ? "" : "Automation G4/W3 cutover gate is not passed",
      consolidation.consumer_zero?.passed ? "" : "deployed compatibility telemetry is not consumer-zero",
      exactConsumers.passed ? "" : `exact drop-set source consumers remain: ${exactConsumers.matches.map((item) => `${item.file}:${item.pattern}`).join(", ")}`,
      release.passed ? "" : "a deployed release/restart reference with zero post-cutover usage is required"
    ].filter(Boolean);
    return {
      blockers,
      consolidation: {
        consumer_zero: consolidation.consumer_zero,
        cutover_gate: consolidation.cutover_gate,
        data_gate: consolidation.data_gate,
        parity_gate: consolidation.parity_gate
      },
      exact_source_consumer_zero: exactConsumers,
      passed: blockers.length === 0,
      release
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function exactSourceConsumerAudit(sourceRoot: string) {
  const checks = [
    ["backend-ts/src/http/readApiDomain.ts", ["listCronTasks"]],
    ["backend-ts/src/http/piGuardianStatus.ts", ["piIssueCompletionWatchCounts"]],
    ["backend-ts/src/integrations/feishuLifecycleNotifications.ts", ["issueCompletionWatchOwnsTargetForIssue"]],
    ["backend-ts/src/runner/piAutoManageScheduler.ts", ["runDueCronTasks(", "runDuePiAutomations(", "queueReadyFeishuCompletionWatchNotifications("]],
    ["backend-ts/src/main.ts", ["sweepActivePiIssueCompletionWatches"]],
    ["backend-ts/src/http/server.ts", ["attachPiIssueCompletionWatchObserver"]]
  ] as const;
  const matches: Array<{ file: string; pattern: string }> = [];
  for (const [file, patterns] of checks) {
    const path = resolve(sourceRoot, file);
    if (!existsSync(path)) {
      matches.push({ file, pattern: "file_missing" });
      continue;
    }
    const source = readFileSync(path, "utf8");
    for (const pattern of patterns) if (source.includes(pattern)) matches.push({ file, pattern });
  }
  return { matches, passed: matches.length === 0, tables: [...LEGACY_AUTOMATION_DROP_TABLES] };
}

function inventoryFor(sqlite: Database) {
  const tables = LEGACY_AUTOMATION_DROP_TABLES.map((table) => ({
    create_sql: schemaSQL(sqlite, "table", table),
    name: table,
    rows: tableExists(sqlite, table) ? count(sqlite, table) : null
  }));
  const placeholders = LEGACY_AUTOMATION_DROP_TABLES.map(() => "?").join(",");
  const indexes = sqlite.query<{ name: string; sql: string | null; tbl_name: string }, string[]>(`
    select name, tbl_name, sql from sqlite_master where type='index' and tbl_name in (${placeholders}) order by tbl_name,name
  `).all(...LEGACY_AUTOMATION_DROP_TABLES).map((row) => ({ name: row.name, table: row.tbl_name, sql: row.sql }));
  return {
    indexes,
    retained: [
      { reason: "live PI heartbeat control/execution audit authority", tables: ["pi_heartbeat_controls", "pi_heartbeat_runs", "pi_heartbeat_events"] },
      { reason: "live report/prompt authorization consumer remains", tables: ["pi_delegations"] },
      { reason: "Issue/Run/Work and PI Action/Approval remain shared authorities", tables: ["issues", "issue_events", "issue_runs", "works", "work_events", "pi_actions", "pi_action_events", "pi_approval_requests"] }
    ],
    tables
  };
}

function archivePayload(sqlite: Database, dbPath: string, inventory: ReturnType<typeof inventoryFor>) {
  const payload = {
    database_sha256: sha256File(dbPath),
    indexes: inventory.indexes,
    migration_id: LEGACY_AUTOMATION_DROP_MIGRATION_ID,
    source_of_truth: "automation_definitions, automation_runs/events and automation_watches are target-primary; this archive is read-only rollback evidence",
    tables: LEGACY_AUTOMATION_DROP_TABLES.map((table) => ({
      create_sql: schemaSQL(sqlite, "table", table),
      name: table,
      rows: tableExists(sqlite, table) ? orderedRows(sqlite, table) : null
    }))
  };
  return { checksum_sha256: sha256(stableJSON(payload)), payload };
}

function archiveContentChecksum(payload: ReturnType<typeof archivePayload>["payload"]): string {
  return sha256(stableJSON({ indexes: payload.indexes, migration_id: payload.migration_id, tables: payload.tables }));
}

function createVerifiedBackup(sqlite: Database, backupPath: string, expectedArchiveChecksum: string) {
  mkdirSync(dirname(backupPath), { recursive: true });
  sqlite.run("vacuum main into ?", [backupPath]);
  const backupHash = sha256File(backupPath);
  const root = mkdtempSync(`${tmpdir()}/xw-p11-09-restore-`);
  const restoredPath = resolve(root, "runner-restored.db");
  try {
    copyFileSync(backupPath, restoredPath);
    const restored = open(restoredPath, true);
    try {
      const restoredInventory = inventoryFor(restored);
      const restoredArchive = archivePayload(restored, restoredPath, restoredInventory);
      const health = databaseHealth(restored);
      if (health.quick_check !== "ok" || health.foreign_key_violations !== 0) {
        throw new Error("isolated backup restore health check failed");
      }
      const restoredContentChecksum = archiveContentChecksum(restoredArchive.payload);
      if (restoredContentChecksum !== expectedArchiveChecksum) {
        throw new Error("isolated backup restore archive checksum mismatch");
      }
      return {
        path: backupPath,
        quick_check: health.quick_check,
        foreign_key_violations: health.foreign_key_violations,
        restore_rehearsal_completed: true,
        restored_archive_checksum_sha256: restoredContentChecksum,
        sha256: backupHash
      };
    } finally {
      restored.close();
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function writeAndVerifyArchive(path: string, candidate: ReturnType<typeof archivePayload>) {
  mkdirSync(dirname(path), { recursive: true });
  const archive = {
    archive_sha256: candidate.checksum_sha256,
    contract: LEGACY_AUTOMATION_ARCHIVE_CONTRACT,
    created_at: new Date().toISOString(),
    payload: candidate.payload
  };
  writeFileSync(path, `${JSON.stringify(archive, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const verification = verifyLegacyAutomationArchive(path);
  return { ...verification, rows: candidate.payload.tables.map((table) => ({ name: table.name, rows: table.rows?.length ?? 0 })) };
}

function baseReport(
  dbPath: string,
  beforeBytes: number,
  inventory: ReturnType<typeof inventoryFor>,
  archive: ReturnType<typeof archivePayload>,
  gate: ReturnType<typeof cleanupGate>,
  operation: string
) {
  return {
    contract: LEGACY_AUTOMATION_CLEANUP_REPORT_CONTRACT,
    archive_candidate: { checksum_sha256: archive.checksum_sha256 },
    database_path: dbPath,
    file_size: { before_bytes: beforeBytes },
    gate,
    generated_at: new Date().toISOString(),
    inventory,
    operation,
    outcome: gate.passed ? "ready" : "blocked",
    rollback: rollbackLimit("<fresh-backup.db>")
  };
}

function rollbackLimit(backupPath: string) {
  return {
    command: `stop all writers; maintenance db migration-rollback --db <target.db> --backup ${backupPath} --report <rollback-report.json> --apply --confirm-backup-tested --confirm-no-active-writers --actor <non-llm> --actor-kind user --audit-ref <ref> --reason <reason>`,
    limit: "Full backup restore is valid only before accepting post-drop writes. After any post-drop write, restore would discard newer authority data and is forbidden; use the archive for forensic/reference recovery and a new forward migration instead.",
    mode: "full SQLite backup restore; no down migration"
  };
}

function authorize(input: LegacyAutomationCleanupInput): Authorization {
  const actor = required(input.actor, "--actor");
  if (actor.toLowerCase() === "llm") throw new Error("--actor cannot be llm");
  if (!input.actorKind || !["automation", "system", "user"].includes(input.actorKind)) {
    throw new Error("--actor-kind must be user, system, or automation");
  }
  return {
    actor,
    actorKind: input.actorKind,
    auditRef: required(input.auditRef, "--audit-ref"),
    reason: required(input.reason, "--reason")
  };
}

function requireConfirmations(input: LegacyAutomationCleanupInput): void {
  if (!input.confirmBackupTested) throw new Error("--confirm-backup-tested is required for apply mode");
  if (!input.confirmNoActiveWriters) throw new Error("--confirm-no-active-writers is required for apply mode");
  if (clean(input.releaseRef) === "") throw new Error("--release-ref is required for apply mode");
}

function requireExactTables(value: string | undefined): void {
  const actual = clean(value).split(",").map((item) => item.trim()).filter(Boolean).sort();
  const expected = [...LEGACY_AUTOMATION_DROP_TABLES].sort();
  if (actual.length !== expected.length || actual.some((table, index) => table !== expected[index])) {
    throw new Error(`--confirm-tables must exactly equal ${expected.join(",")}`);
  }
}

function databaseHealth(sqlite: Database) {
  return {
    foreign_key_violations: sqlite.query("pragma foreign_key_check").all().length,
    quick_check: scalar(sqlite, "pragma quick_check")
  };
}

function open(path: string, readonly: boolean): Database {
  const sqlite = new Database(path, { readonly, readwrite: !readonly, strict: true });
  sqlite.run("pragma busy_timeout=5000");
  sqlite.run("pragma foreign_keys=on");
  return sqlite;
}

function orderedRows(sqlite: Database, table: string): Record<string, unknown>[] {
  return sqlite.query<Record<string, unknown>, []>(`select * from ${table} order by rowid`).all();
}

function schemaSQL(sqlite: Database, type: string, name: string): string | null {
  return sqlite.query<{ sql: string | null }, [string, string]>(
    "select sql from sqlite_master where type=? and name=?"
  ).get(type, name)?.sql ?? null;
}

function count(sqlite: Database, table: string): number {
  return sqlite.query<{ count: number }, []>(`select count(*) as count from ${table}`).get()?.count ?? 0;
}

function tableExists(sqlite: Database, table: string): boolean {
  return Boolean(sqlite.query("select name from sqlite_master where type='table' and name=?").get(table));
}

function scalar(sqlite: Database, sql: string): string {
  const row = sqlite.query<Record<string, unknown>, []>(sql).get() ?? {};
  return String(Object.values(row)[0] ?? "");
}

function sha256File(path: string): string {
  return sha256(readFileSync(path));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJSON(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableValue(item)]));
}

function writeJSON(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function assertDistinct(...paths: string[]): void {
  if (new Set(paths.map((path) => resolve(path))).size !== paths.length) {
    throw new Error("database, report, backup, and archive paths must be different");
  }
}

function resolveRequired(value: string | undefined, flag: string): string {
  return resolve(required(value, flag));
}

function required(value: string | undefined, flag: string): string {
  const text = clean(value);
  if (text === "") throw new Error(`${flag} is required`);
  return text;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
