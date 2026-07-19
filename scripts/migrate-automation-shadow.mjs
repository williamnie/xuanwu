#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { backfillPiAutomationShadows } from "../backend-ts/src/db/repositories/piAutomationShadow.ts";
import { migrateLegacyCompletionWatches } from "../backend-ts/src/db/repositories/automationWatches.ts";

const args = parseArgs(process.argv.slice(2));
if (!args.db) usage("--db <runner.db> is required");
if (args.applyToCopy) validateApplyArguments(args);

const timestamp = new Date().toISOString();
const audit = {
  actor_id: args.actor || "automation-shadow-dry-run",
  actor_kind: "system",
  correlation_id: args.correlation || `automation-shadow-dry-run:${timestamp}`,
  event_id: `automation-shadow-backfill:${args.correlation || timestamp}`,
  gate: {
    authority: "deterministic_policy",
    decision: "allow",
    policy_ref: "automation-shadow-w1:copy-only:v1"
  },
  occurred_at: timestamp,
  reason: args.reason || "read-only W1 Automation shadow preview"
};

if (args.applyToCopy) assertBackupCopy(args.sourceDb, args.db);
const sqlite = new Database(args.db, {
  readonly: !args.applyToCopy,
  readwrite: args.applyToCopy,
  strict: true
});
sqlite.run("pragma foreign_keys=on");
const database = wrapDatabase(sqlite, args.db, !args.applyToCopy);
try {
  const before = snapshot(database);
  const pi = backfillPiAutomationShadows(database, { apply: args.applyToCopy, audit });
  const watches = migrateLegacyCompletionWatches(database, { audit, dryRun: !args.applyToCopy });
  const after = snapshot(database);
  console.log(JSON.stringify({
    schema_version: "xuanwu.automation-shadow-migration-report.v1",
    mode: args.applyToCopy ? "apply_to_copy" : "dry_run",
    database: resolve(args.db),
    source_database: args.sourceDb ? resolve(args.sourceDb) : null,
    generated_at: timestamp,
    safety: {
      live_write: false,
      target_definitions_forced_draft: true,
      external_writes: false,
      source_legacy_checksum: args.sourceDb ? readonlyLegacyChecksum(args.sourceDb) : null
    },
    before,
    backfill: { pi_automations: pi, completion_watches: watches },
    after
  }, null, 2));
} finally {
  database.close();
}

function validateApplyArguments(values) {
  if (!values.sourceDb) usage("--apply-to-copy requires --source-db <authoritative.db>");
  if (!values.actor || values.actor.toLowerCase() === "llm") usage("--apply-to-copy requires a non-LLM --actor");
  if (!values.correlation) usage("--apply-to-copy requires --correlation");
  if (!values.reason) usage("--apply-to-copy requires --reason");
}

function assertBackupCopy(sourcePath, targetPath) {
  const source = realpathSync(sourcePath);
  const target = realpathSync(targetPath);
  const sourceStat = statSync(source);
  const targetStat = statSync(target);
  if (source === target || (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino)) {
    usage("source DB and apply target must be different files");
  }
  const sourceDb = openReadonly(source);
  const targetDb = openReadonly(target);
  try {
    assertHealthy(sourceDb, "source");
    assertHealthy(targetDb, "target copy");
    const sourceMigrations = rows(sourceDb, "select id from schema_migrations order by id");
    const targetMigrations = rows(targetDb, "select id from schema_migrations order by id");
    if (stableJson(sourceMigrations) !== stableJson(targetMigrations)) usage("target schema_migrations differ from source DB");
    if (legacyChecksum(sourceDb) !== legacyChecksum(targetDb)) {
      usage("target legacy Automation carriers differ from source DB; create a fresh isolated backup copy first");
    }
  } finally {
    sourceDb.close();
    targetDb.close();
  }
}

function snapshot(database) {
  const sqlite = database.sqlite;
  assertHealthy(sqlite, "database");
  const tables = [
    "cron_tasks", "cron_task_schedules", "pi_automations", "pi_delegations",
    "pi_heartbeat_controls", "pi_heartbeat_runs", "pi_heartbeat_events",
    "pi_issue_completion_watches", "pi_issue_completion_watch_items",
    "automation_definitions", "automation_trigger_configs", "automation_runs",
    "automation_run_events", "automation_events", "automation_watches"
  ];
  return {
    quick_check: scalar(sqlite, "pragma quick_check"),
    foreign_key_violations: rows(sqlite, "pragma foreign_key_check").length,
    counts: Object.fromEntries(tables.map((table) => [table, tableExists(sqlite, table) ? count(sqlite, table) : null])),
    legacy_checksum: legacyChecksum(sqlite)
  };
}

function legacyChecksum(sqlite) {
  const tables = ["pi_automations", "pi_issue_completion_watches", "pi_issue_completion_watch_items"];
  const value = Object.fromEntries(tables.map((table) => [table,
    tableExists(sqlite, table) ? rows(sqlite, `select * from ${table} order by rowid`) : null
  ]));
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function wrapDatabase(sqlite, path, readonly) {
  return {
    sqlite,
    path: resolve(path),
    readonly,
    close: () => sqlite.close(),
    transaction: (inside) => sqlite.transaction(inside)
  };
}

function openReadonly(path) {
  return new Database(path, { readonly: true, strict: true });
}

function readonlyLegacyChecksum(path) {
  const sqlite = openReadonly(path);
  try { return legacyChecksum(sqlite); } finally { sqlite.close(); }
}

function assertHealthy(sqlite, label) {
  if (scalar(sqlite, "pragma quick_check") !== "ok") usage(`${label} quick_check failed`);
  if (rows(sqlite, "pragma foreign_key_check").length > 0) usage(`${label} foreign_key_check failed`);
}

function tableExists(sqlite, table) {
  return Boolean(sqlite.query("select name from sqlite_master where type='table' and name=?").get(table));
}

function count(sqlite, table) {
  return Number(sqlite.query(`select count(*) as count from ${table}`).get()?.count ?? 0);
}

function scalar(sqlite, sql) {
  return String(Object.values(sqlite.query(sql).get() || {})[0] || "");
}

function rows(sqlite, sql) {
  return sqlite.query(sql).all();
}

function stableJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, sortValue(item)]));
}

function parseArgs(argv) {
  const values = { actor: "", applyToCopy: false, correlation: "", db: "", reason: "", sourceDb: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply-to-copy") values.applyToCopy = true;
    else if (arg === "--actor") values.actor = argv[++index] || "";
    else if (arg === "--correlation") values.correlation = argv[++index] || "";
    else if (arg === "--db") values.db = argv[++index] || "";
    else if (arg === "--reason") values.reason = argv[++index] || "";
    else if (arg === "--source-db") values.sourceDb = argv[++index] || "";
    else usage(`unknown argument: ${arg}`);
  }
  return values;
}

function usage(message) {
  console.error(message);
  console.error("usage: migrate-automation-shadow.mjs --db <runner.db> [--apply-to-copy --source-db <authoritative.db> --actor <non-llm> --correlation <id> --reason <text>]");
  process.exit(2);
}
