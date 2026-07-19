import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { RunnerDatabase } from "../../db/database.ts";
import { migrateLegacyCompletionWatches } from "../../db/repositories/automationWatches.ts";
import { comparePiAutomationShadows } from "../../db/repositories/piAutomationShadow.ts";
import { AUTOMATION_TABLES, AUTOMATION_TARGET_TABLES } from "../../xuanwu/automationSemantics.ts";

type CountRow = { count: number };

export const AUTOMATION_CONSOLIDATION_AUDIT_CONTRACT = "xw.automation-consolidation-audit.v1" as const;

export function auditAutomationConsolidation(input: {
  dbPath: string;
  reportPath: string;
}): Record<string, unknown> {
  const dbPath = resolve(required(input.dbPath, "dbPath"));
  const reportPath = resolve(required(input.reportPath, "reportPath"));
  if (dbPath === reportPath) throw new Error("database and report paths must be different");
  const sqlite = new Database(dbPath, { readonly: true, strict: true });
  try {
    const requiredTables = [...AUTOMATION_TABLES, ...AUTOMATION_TARGET_TABLES];
    const missingTables = requiredTables.filter((table) => !tableExists(sqlite, table));
    const counts = Object.fromEntries(requiredTables.map((table) => [
      table,
      tableExists(sqlite, table) ? count(sqlite, `select count(*) as count from ${table}`) : null
    ]));
    const rowChecks = {
      active_or_paused_delegations: conditionalCount(sqlite, "pi_delegations", "status in ('active','paused')"),
      active_or_satisfied_legacy_watches: conditionalCount(
        sqlite,
        "pi_issue_completion_watches",
        "status='active' or (status='satisfied' and notified_at='')"
      ),
      claimed_cron_tasks: conditionalCount(sqlite, "cron_tasks", "claim_token<>''", "claim_token"),
      claimed_pi_automations: conditionalCount(sqlite, "pi_automations", "lock_token<>''", "lock_token"),
      nonterminal_cron_tasks: conditionalCount(sqlite, "cron_tasks", "status<>'done'"),
      nonterminal_nightly_batches: conditionalCount(sqlite, "nightly_batches", "status<>'done'"),
      nonterminal_nightly_items: conditionalCount(
        sqlite,
        "nightly_batch_items",
        "status not in ('done','failed','skipped')"
      ),
      orphan_nightly_items: hasTables(sqlite, ["nightly_batches", "nightly_batch_items"])
        ? count(sqlite, `select count(*) as count from nightly_batch_items i
            where not exists (select 1 from nightly_batches b where b.id=i.batch_id)`)
        : null,
      running_heartbeat_runs: conditionalCount(sqlite, "pi_heartbeat_runs", "status='running'"),
      unsafe_pi_shadows: hasTables(sqlite, ["automation_definitions"])
        ? count(sqlite, `select count(*) as count from automation_definitions
            where id like 'automation:legacy-pi-%' and (status<>'draft' or next_run_at is not null)`)
        : null,
      unsafe_watch_shadows: hasTables(sqlite, ["automation_definitions", "automation_watches"])
        ? count(sqlite, `select count(*) as count from automation_watches w
            join automation_definitions d on d.id=w.automation_id
            where w.migration_mode='legacy_shadow' and d.next_run_at is not null`)
        : null
    };
    const rowBlockers = Object.entries(rowChecks)
      .filter(([, value]) => value === null || value > 0)
      .map(([name, value]) => value === null ? `${name} could not be checked` : `${name}=${value}`);
    const parity = shadowParity(sqlite, dbPath, missingTables);
    const parityBlockers = [
      ...parity.pi_automations.drift.map((item) => `pi_automation shadow drift: ${stableJson(item)}`),
      parity.completion_watches.created > 0
        ? `completion_watch shadows missing=${parity.completion_watches.created}`
        : "",
      parity.completion_watches.refreshed > 0
        ? `completion_watch shadows stale=${parity.completion_watches.refreshed}`
        : "",
      parity.orphan_pi_automation_shadows > 0
        ? `orphan pi_automation shadows=${parity.orphan_pi_automation_shadows}`
        : "",
      parity.orphan_completion_watch_shadows > 0
        ? `orphan completion_watch shadows=${parity.orphan_completion_watch_shadows}`
        : ""
    ].filter(Boolean);
    const health = {
      foreign_key_violations: rows(sqlite, "pragma foreign_key_check").length,
      quick_check: scalarText(sqlite, "pragma quick_check")
    };
    const healthBlockers = [
      health.quick_check === "ok" ? "" : `quick_check=${health.quick_check}`,
      health.foreign_key_violations === 0 ? "" : `foreign_key_violations=${health.foreign_key_violations}`,
      ...missingTables.map((table) => `required table missing: ${table}`)
    ].filter(Boolean);
    const report = {
      contract: AUTOMATION_CONSOLIDATION_AUDIT_CONTRACT,
      counts,
      data_gate: {
        blockers: [...healthBlockers, ...rowBlockers],
        passed: healthBlockers.length === 0 && rowBlockers.length === 0
      },
      db_path: dbPath,
      delete_gate: {
        blockers: [
          "current authority is G0/W1 legacy-primary; W2 target-primary and G4 single-writer cutover are not established",
          "W3 target-only restart, retry, missed-trigger, pause, watch-dedupe, and delivery recovery evidence is required",
          "one formal release of zero legacy storage/API/scheduler consumers is required",
          "fresh backup, checksum archive, isolated restore, and retained rollback evidence are required",
          "P11.09 and exact non-LLM G7 destructive approval are required"
        ],
        destructive_delete_authorized: false
      },
      generated_at: new Date().toISOString(),
      health,
      legacy_checksum: tableChecksum(sqlite, AUTOMATION_TABLES),
      nightly_archive_candidate: nightlyArchiveCandidate(sqlite),
      operation: "automation.consolidation-audit",
      parity_gate: {
        blockers: parityBlockers,
        passed: healthBlockers.length === 0 && parityBlockers.length === 0
      },
      row_checks: rowChecks,
      shadow_parity: parity,
      source_of_truth: "G0/W1 legacy carriers remain primary; automation_* rows are non-executing shadows or native target records",
      target_checksum: tableChecksum(sqlite, AUTOMATION_TARGET_TABLES)
    };
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  } finally {
    sqlite.close();
  }
}

function shadowParity(sqlite: Database, dbPath: string, missingTables: string[]) {
  if (missingTables.length > 0) {
    return {
      completion_watches: { created: 0, refreshed: 0, scanned: 0, unchanged: 0 },
      orphan_completion_watch_shadows: 0,
      orphan_pi_automation_shadows: 0,
      pi_automations: { checksum: "", drift: [{ axis: "schema", detail: "required tables are missing" }] }
    };
  }
  const db = readonlyRunnerDatabase(sqlite, dbPath);
  const audit = {
    actor_id: "automation-consolidation-audit",
    actor_kind: "system" as const,
    correlation_id: "automation-consolidation-audit:readonly",
    event_id: "automation-consolidation-audit:readonly",
    gate: {
      authority: "deterministic_policy" as const,
      decision: "allow" as const,
      policy_ref: "automation-shadow-w1:readonly-audit:v1"
    },
    occurred_at: new Date().toISOString(),
    reason: "read-only Automation consolidation audit"
  };
  return {
    completion_watches: migrateLegacyCompletionWatches(db, { audit, dryRun: true }),
    orphan_completion_watch_shadows: count(sqlite, `select count(*) as count from automation_watches w
      where w.migration_mode='legacy_shadow' and not exists (
        select 1 from pi_issue_completion_watches l where l.id=w.legacy_watch_id
      )`),
    orphan_pi_automation_shadows: count(sqlite, `select count(*) as count from automation_definitions d
      where d.id like 'automation:legacy-pi-%' and not exists (
        select 1 from pi_automations l where d.id='automation:legacy-pi-' || cast(l.id as text)
      )`),
    pi_automations: comparePiAutomationShadows(db)
  };
}

function nightlyArchiveCandidate(sqlite: Database) {
  const batches = tableExists(sqlite, "nightly_batches") ? orderedTableRows(sqlite, "nightly_batches") : null;
  const items = tableExists(sqlite, "nightly_batch_items") ? orderedTableRows(sqlite, "nightly_batch_items") : null;
  const payload = { batches, items };
  return {
    archive_only: true,
    checksum_sha256: sha256(stableJson(payload)),
    contract: "xw.nightly-batch-archive-candidate.v1",
    payload,
    restore_rehearsal_completed: false
  };
}

function readonlyRunnerDatabase(sqlite: Database, path: string): RunnerDatabase {
  return {
    sqlite,
    path,
    readonly: true,
    close: () => undefined,
    transaction: (inside) => sqlite.transaction(inside)
  };
}

function conditionalCount(sqlite: Database, table: string, condition: string, column?: string): number | null {
  if (!tableExists(sqlite, table) || (column && !columnExists(sqlite, table, column))) return null;
  return count(sqlite, `select count(*) as count from ${table} where ${condition}`);
}

function tableChecksum(sqlite: Database, tables: readonly string[]): string {
  const value = Object.fromEntries(tables.map((table) => [
    table,
    tableExists(sqlite, table) ? orderedTableRows(sqlite, table) : null
  ]));
  return sha256(stableJson(value));
}

function orderedTableRows(sqlite: Database, table: string): Record<string, unknown>[] {
  return sqlite.query<Record<string, unknown>, []>(`select * from ${table} order by rowid`).all();
}

function tableExists(sqlite: Database, table: string): boolean {
  return Boolean(sqlite.query("select name from sqlite_master where type='table' and name=?").get(table));
}

function columnExists(sqlite: Database, table: string, column: string): boolean {
  return rows(sqlite, `pragma table_info(${table})`).some((row) => row.name === column);
}

function hasTables(sqlite: Database, tables: string[]): boolean {
  return tables.every((table) => tableExists(sqlite, table));
}

function count(sqlite: Database, sql: string): number {
  return sqlite.query<CountRow, []>(sql).get()?.count ?? 0;
}

function scalarText(sqlite: Database, sql: string): string {
  const row = sqlite.query<Record<string, unknown>, []>(sql).get();
  return row ? String(Object.values(row)[0] ?? "") : "";
}

function rows(sqlite: Database, sql: string): Record<string, unknown>[] {
  return sqlite.query<Record<string, unknown>, []>(sql).all();
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, sortValue(item)]));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function required(value: string, name: string): string {
  const text = value?.trim() ?? "";
  if (text === "") throw new Error(`${name} is required`);
  return text;
}
