#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createAutomation, getAutomation, recordAutomationEvent } from "../backend-ts/src/db/repositories/automations.ts";
import { migrateLegacyCompletionWatches } from "../backend-ts/src/db/repositories/automationWatches.ts";
import { INVESTIGATE_WORKFLOW_REF } from "../backend-ts/src/workflows/investigate.ts";
import { AUTOMATION_TABLES, AUTOMATION_TARGET_TABLES } from "../backend-ts/src/xuanwu/automationSemantics.ts";

const args = parseArgs(process.argv.slice(2));
validateArgs(args);
const dbPath = resolve(args.db);
const backupPath = resolve(args.backupDb);
if (dbPath === backupPath) fail("--db and --backup-db must be different files");
const sqlite = new Database(dbPath, { readwrite: args.apply, readonly: !args.apply, strict: true });
const backup = new Database(backupPath, { readonly: true, strict: true });
const db = wrap(sqlite, dbPath, !args.apply);
try {
  assertHealthy(sqlite, "target database");
  assertHealthy(backup, "backup database");
  const before = snapshot(sqlite);
  const backupSnapshot = snapshot(backup);
  if (before.legacy_checksum !== backupSnapshot.legacy_checksum) {
    fail("backup legacy checksum differs from the pre-cutover database");
  }
  if (stableJson(before.schema_migrations) !== stableJson(backupSnapshot.schema_migrations)) {
    fail("backup schema_migrations differ from the pre-cutover database");
  }
  const blockers = preflightBlockers(sqlite);
  if (blockers.length > 0) fail(`target-primary preflight blocked: ${blockers.join("; ")}`);
  const archive = archivePayload(sqlite);
  const audit = auditInput(args);
  const result = args.apply ? applyCutover(db, audit, before, archive) : planCutover(sqlite);
  const after = snapshot(sqlite);
  const report = {
    contract: "xw.automation-target-primary-migration.v1",
    mode: args.apply ? "apply" : "plan",
    database: dbPath,
    backup_database: backupPath,
    generated_at: audit.occurred_at,
    authority: {
      source_of_truth: args.apply ? "automation_definitions" : "legacy-primary-before-apply",
      dual_write: "none",
      legacy_scheduler: args.apply ? "disabled-by-release" : "must be disabled by release",
      destructive_delete: false
    },
    gate: {
      actor_id: audit.actor_id,
      actor_kind: audit.actor_kind,
      policy_ref: audit.gate.policy_ref,
      backup_checksum_verified: true,
      backup_restore_rehearsal_confirmed: args.confirmBackupTested,
      no_active_writers_confirmed: args.confirmNoActiveWriters
    },
    before,
    migration: result,
    archive: { ...archive, output_path: resolve(args.archive) },
    after,
    rollback: {
      method: "stop target release; restore retained SQLite backup; deploy previous release; never enable both writers",
      backup_database: backupPath,
      verification_command: `scripts/verify-automation-rollback.mjs --backup-db ${JSON.stringify(backupPath)} --restored-db <restored-copy> --report <report.json>`
    }
  };
  mkdirSync(dirname(resolve(args.archive)), { recursive: true });
  writeFileSync(resolve(args.archive), `${JSON.stringify(archive, null, 2)}\n`);
  mkdirSync(dirname(resolve(args.report)), { recursive: true });
  writeFileSync(resolve(args.report), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  sqlite.close();
  backup.close();
}

function applyCutover(db, audit, before, archive) {
  const cronRows = rows(db.sqlite, "select * from cron_tasks order by id");
  const delegationRows = rows(db.sqlite, "select * from pi_delegations order by id");
  let watchShadows;
  const created = [];
  const unchanged = [];
  db.transaction(() => {
    watchShadows = migrateLegacyCompletionWatches(db, { audit, dryRun: false });
    for (const row of cronRows) archiveCarrier(db, "cron", row, audit, created, unchanged);
    for (const row of delegationRows) archiveCarrier(db, "delegation", row, audit, created, unchanged);
    db.sqlite.run("update automation_watches set migration_mode='native', updated_at=? where migration_mode='legacy_shadow'", [audit.occurred_at]);
    ensureCutoverMarker(db, audit, {
      archive_checksum: archive.checksum_sha256,
      legacy_checksum: before.legacy_checksum,
      migrated_cron: cronRows.length,
      migrated_delegations: delegationRows.length,
      migrated_watches: watchShadows.scanned
    }, created, unchanged);
  }).immediate();
  if (!watchShadows) fail("completion watch migration did not run");
  return {
    created_automation_ids: created,
    unchanged_automation_ids: unchanged,
    cron_archived: cronRows.length,
    delegations_archived: delegationRows.length,
    heartbeat_history_retained: count(db.sqlite, "select count(*) as count from pi_heartbeat_runs"),
    nightly_rows_archived: archive.payload.batches.length + archive.payload.items.length,
    pi_automations_migrated: 0,
    completion_watches: watchShadows,
    legacy_rows_deleted: 0
  };
}

function planCutover(sqlite) {
  return {
    cron_archived: count(sqlite, "select count(*) as count from cron_tasks"),
    delegations_archived: count(sqlite, "select count(*) as count from pi_delegations"),
    heartbeat_history_retained: count(sqlite, "select count(*) as count from pi_heartbeat_runs"),
    nightly_rows_archived: count(sqlite, "select count(*) as count from nightly_batches") + count(sqlite, "select count(*) as count from nightly_batch_items"),
    pi_automations_migrated: count(sqlite, "select count(*) as count from pi_automations"),
    completion_watches: count(sqlite, "select count(*) as count from pi_issue_completion_watches"),
    legacy_rows_deleted: 0
  };
}

function archiveCarrier(db, carrier, row, audit, created, unchanged) {
  const raw = String(row.id);
  const id = `automation:legacy-${carrier}-${slug(raw)}`;
  if (getAutomation(db, id)) { unchanged.push(id); return; }
  const projectID = String(row.project_id || "");
  const owner = projectID && db.sqlite.query("select id from projects where id=?").get(projectID)
    ? { kind: "project", project_id: projectID }
    : { kind: "control_plane", control_plane_id: "local" };
  createAutomation(db, {
    id,
    idempotency_namespace: `legacy:${carrier}:${raw}`,
    mode: "observe",
    name: String(row.name || row.title || `Legacy ${carrier} ${raw}`),
    next_run_at: null,
    owner,
    permission_policy_ref: owner.kind === "project" ? `project-policy:${owner.project_id}` : "control-plane-policy:local",
    status: "archived",
    trigger: { type: "manual", config: {} },
    trigger_created_by: audit.actor_id,
    workflow_ref: INVESTIGATE_WORKFLOW_REF
  }, audit.occurred_at, derivedAudit(audit, `${carrier}-${raw}`, "created"));
  recordAutomationEvent(db, id, "automation.legacy_carrier_archived.v1", derivedAudit(audit, `${carrier}-${raw}`, "snapshot"), {
    carrier,
    source_row: row,
    source_table: carrier === "cron" ? "cron_tasks" : "pi_delegations"
  });
  created.push(id);
}

function ensureCutoverMarker(db, audit, payload, created, unchanged) {
  const id = "automation:cutover-739";
  if (getAutomation(db, id)) { unchanged.push(id); return; }
  createAutomation(db, {
    id,
    idempotency_namespace: "xw:p11.04:target-primary",
    mode: "observe",
    name: "XW P11.04 target-primary cutover marker",
    next_run_at: null,
    owner: { kind: "control_plane", control_plane_id: "local" },
    permission_policy_ref: "migration-policy:automation-target-primary:v1",
    status: "archived",
    trigger: { type: "manual", config: {} },
    trigger_created_by: audit.actor_id,
    workflow_ref: INVESTIGATE_WORKFLOW_REF
  }, audit.occurred_at, derivedAudit(audit, "cutover-739", "created"));
  recordAutomationEvent(db, id, "automation.target_primary_cutover.v1", derivedAudit(audit, "cutover-739", "completed"), payload);
  created.push(id);
}

function preflightBlockers(sqlite) {
  const checks = [
    ["claimed cron tasks", "select count(*) as count from cron_tasks where claim_token<>''"],
    ["nonterminal cron tasks", "select count(*) as count from cron_tasks where status<>'done'"],
    ["PI automations requiring semantic workflow migration", "select count(*) as count from pi_automations"],
    ["active or paused delegations", "select count(*) as count from pi_delegations where status in ('active','paused')"],
    ["running heartbeat executions", "select count(*) as count from pi_heartbeat_runs where status='running'"],
    ["nonterminal nightly batches", "select count(*) as count from nightly_batches where status<>'done'"],
    ["nonterminal nightly items", "select count(*) as count from nightly_batch_items where status not in ('done','failed','skipped')"]
  ];
  return checks.flatMap(([label, sql]) => { const value = count(sqlite, sql); return value ? [`${label}=${value}`] : []; });
}

function archivePayload(sqlite) {
  const payload = {
    batches: rows(sqlite, "select * from nightly_batches order by rowid"),
    items: rows(sqlite, "select * from nightly_batch_items order by rowid")
  };
  return {
    contract: "xw.nightly-batch-archive.v1",
    archive_only: true,
    checksum_sha256: sha256(stableJson(payload)),
    payload
  };
}

function snapshot(sqlite) {
  return {
    quick_check: scalar(sqlite, "pragma quick_check"),
    foreign_key_violations: rows(sqlite, "pragma foreign_key_check").length,
    schema_migrations: rows(sqlite, "select id from schema_migrations order by id"),
    counts: Object.fromEntries([...AUTOMATION_TABLES, ...AUTOMATION_TARGET_TABLES].map((table) => [table, count(sqlite, `select count(*) as count from ${table}`)])),
    legacy_checksum: tableChecksum(sqlite, AUTOMATION_TABLES),
    target_checksum: tableChecksum(sqlite, AUTOMATION_TARGET_TABLES),
    cutover_marker: Boolean(sqlite.query("select id from automation_definitions where id='automation:cutover-739'").get())
  };
}

function auditInput(args) {
  const occurredAt = new Date().toISOString();
  return {
    actor_id: args.actor,
    actor_kind: "system",
    correlation_id: args.correlation,
    event_id: `automation-target-primary:${args.correlation}`,
    gate: { authority: "deterministic_policy", decision: "allow", policy_ref: "automation-target-primary:g4:v1" },
    occurred_at: occurredAt,
    reason: args.reason
  };
}
function derivedAudit(audit, suffix, operation) { return { ...audit, correlation_id: `${audit.correlation_id}:${suffix}`, event_id: `${audit.event_id}:${suffix}:${operation}`, reason: `${audit.reason}; ${suffix} ${operation}` }; }
function tableChecksum(sqlite, tables) { return sha256(stableJson(Object.fromEntries(tables.map((table) => [table, rows(sqlite, `select * from ${table} order by rowid`)])))); }
function wrap(sqlite, path, readonly) { return { sqlite, path, readonly, close: () => undefined, transaction: (inside) => sqlite.transaction(inside) }; }
function assertHealthy(sqlite, label) { if (scalar(sqlite, "pragma quick_check") !== "ok") fail(`${label} quick_check failed`); if (rows(sqlite, "pragma foreign_key_check").length) fail(`${label} foreign_key_check failed`); }
function count(sqlite, sql) { return Number(sqlite.query(sql).get()?.count || 0); }
function scalar(sqlite, sql) { return String(Object.values(sqlite.query(sql).get() || {})[0] || ""); }
function rows(sqlite, sql) { return sqlite.query(sql).all(); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function stableJson(value) { return JSON.stringify(sortValue(value)); }
function sortValue(value) { if (Array.isArray(value)) return value.map(sortValue); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortValue(item)])); }
function slug(value) { return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || sha256(String(value)).slice(0, 16); }
function parseArgs(argv) { const out = { actor: "", apply: false, archive: "", backupDb: "", confirmBackupTested: false, confirmNoActiveWriters: false, correlation: "", db: "", reason: "", report: "" }; for (let i=0;i<argv.length;i+=1) { const arg=argv[i]; if (arg==="--apply") out.apply=true; else if (arg==="--confirm-backup-tested") out.confirmBackupTested=true; else if (arg==="--confirm-no-active-writers") out.confirmNoActiveWriters=true; else if (arg==="--actor") out.actor=argv[++i]||""; else if (arg==="--archive") out.archive=argv[++i]||""; else if (arg==="--backup-db") out.backupDb=argv[++i]||""; else if (arg==="--correlation") out.correlation=argv[++i]||""; else if (arg==="--db") out.db=argv[++i]||""; else if (arg==="--reason") out.reason=argv[++i]||""; else if (arg==="--report") out.report=argv[++i]||""; else fail(`unknown argument: ${arg}`); } return out; }
function validateArgs(args) { for (const key of ["db","backupDb","archive","report","actor","correlation","reason"]) if (!args[key]) fail(`--${key.replace(/[A-Z]/g, (c)=>`-${c.toLowerCase()}`)} is required`); if (args.actor.toLowerCase()==="llm") fail("--actor must be a non-LLM system actor"); if (args.apply && (!args.confirmBackupTested || !args.confirmNoActiveWriters)) fail("--apply requires --confirm-backup-tested and --confirm-no-active-writers"); }
function fail(message) { console.error(message); process.exit(2); }
