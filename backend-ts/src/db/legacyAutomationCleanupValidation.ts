import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { auditAutomationConsolidation } from "../domain/automation/consolidationAudit.ts";
import { LEGACY_AUTOMATION_DROP_TABLES } from "./schema/053_drop_legacy_automation_tables.ts";
import { cleanString } from "../util/values.ts";
import { type LegacyAutomationCleanupInput, type Authorization } from "./legacyAutomationCleanupModel.ts";

export function cleanupGate(dbPath: string, sourceRoot: string, releaseRef: string | undefined) {
  const root = mkdtempSync(`${tmpdir()}/xw-p11-09-audit-`);
  try {
    const consolidation = auditAutomationConsolidation({
      dbPath,
      reportPath: resolve(root, "automation-consolidation.json"),
      sourceRoot
    }) as Record<string, any>;
    const exactConsumers = exactSourceConsumerAudit(sourceRoot);
    const release = {
      passed: cleanString(releaseRef) !== "" && consolidation.consumer_zero?.compatibility_usage_since_cutover === 0,
      ref: cleanString(releaseRef),
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
    ["backend-ts/src/http/pi/piGuardianStatus.ts", ["piIssueCompletionWatchCounts"]],
    ["backend-ts/src/integrations/feishu/feishuLifecycleNotifications.ts", ["issueCompletionWatchOwnsTargetForIssue"]],
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

export function rollbackLimit(backupPath: string) {
  return {
    command: `stop all writers; maintenance db migration-rollback --db <target.db> --backup ${backupPath} --report <rollback-report.json> --apply --confirm-backup-tested --confirm-no-active-writers --actor <non-llm> --actor-kind user --audit-ref <ref> --reason <reason>`,
    limit: "Full backup restore is valid only before accepting post-drop writes. After any post-drop write, restore would discard newer authority data and is forbidden; use the archive for forensic/reference recovery and a new forward migration instead.",
    mode: "full SQLite backup restore; no down migration"
  };
}

export function authorize(input: LegacyAutomationCleanupInput): Authorization {
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

export function requireConfirmations(input: LegacyAutomationCleanupInput): void {
  if (!input.confirmBackupTested) throw new Error("--confirm-backup-tested is required for apply mode");
  if (!input.confirmNoActiveWriters) throw new Error("--confirm-no-active-writers is required for apply mode");
  if (cleanString(input.releaseRef) === "") throw new Error("--release-ref is required for apply mode");
}

export function requireExactTables(value: string | undefined): void {
  const actual = cleanString(value).split(",").map((item) => item.trim()).filter(Boolean).sort();
  const expected = [...LEGACY_AUTOMATION_DROP_TABLES].sort();
  if (actual.length !== expected.length || actual.some((table, index) => table !== expected[index])) {
    throw new Error(`--confirm-tables must exactly equal ${expected.join(",")}`);
  }
}

export function databaseHealth(sqlite: Database) {
  return {
    foreign_key_violations: sqlite.query("pragma foreign_key_check").all().length,
    quick_check: scalar(sqlite, "pragma quick_check")
  };
}

export function open(path: string, readonly: boolean): Database {
  const sqlite = new Database(path, { readonly, readwrite: !readonly, strict: true });
  sqlite.run("pragma busy_timeout=5000");
  sqlite.run("pragma foreign_keys=on");
  return sqlite;
}

function scalar(sqlite: Database, sql: string): string {
  const row = sqlite.query<Record<string, unknown>, []>(sql).get() ?? {};
  return String(Object.values(row)[0] ?? "");
}

export function assertDistinct(...paths: string[]): void {
  if (new Set(paths.map((path) => resolve(path))).size !== paths.length) {
    throw new Error("database, report, backup, and archive paths must be different");
  }
}

export function resolveRequired(value: string | undefined, flag: string): string {
  return resolve(required(value, flag));
}

function required(value: string | undefined, flag: string): string {
  const text = cleanString(value);
  if (text === "") throw new Error(`${flag} is required`);
  return text;
}
