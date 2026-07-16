import { createHash, randomUUID } from "node:crypto";
import { Database as SQLiteDatabase } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { RunnerDatabase } from "../../db/database.ts";
import { quickCheck, recordMaintenanceAudit } from "../../db/repositories/eventMaintenance.ts";
import { listIssues } from "../../db/repositories/issues.ts";
import { getWork, getWorkEvent, listWorkEvents, listWorks } from "../../db/repositories/workLedger.ts";
import type { DomainActor } from "../../xuanwu/coreDomainContracts.ts";
import type { WorkLedgerEntry, WorkTransitionAudit } from "./contracts.ts";
import {
  issueIDToWorkID,
  readIssueWorkDual,
  syncIssueWorkShadow,
  workIDToIssueID
} from "./issueAdapter.ts";

export const WORK_BACKFILL_CHECKPOINT_SCHEMA_VERSION = "xuanwu.work-backfill-checkpoint.v1" as const;
export const WORK_ROLLBACK_CHECKPOINT_SCHEMA_VERSION = "xuanwu.work-rollback-checkpoint.v1" as const;
export const WORK_CONSISTENCY_REPORT_SCHEMA_VERSION = "xuanwu.work-consistency-report.v1" as const;

export const WORK_MIGRATION_POLICY = {
  conflict_rule: "legacy_wins_before_G4",
  dual_read: "W1_legacy_primary_target_comparison_then_W2_target_primary_legacy_fallback",
  dual_read_deadline: "W1_and_W2_only_max_two_formal_release_windows",
  dual_write: "W1_optional_idempotent_legacy_primary_target_shadow_only",
  final_delete_gate: "P11.05/P11.09-and-G7-and-zero-Issue-consumers-and-backup-restore-observation-window",
  repair_mode: "proposal_only",
  rollback: "disable_target_reads_and_shadow_writes_then_remove_only_unchanged_rows_created_by_the_selected_backfill_run",
  source_of_truth: "issues",
  target_role: "shadow",
  write_window: "W1_only_max_one_formal_release_window"
} as const;

type MigrationActorKind = Extract<DomainActor["kind"], "automation" | "system" | "user">;

type MigrationAuthorization = {
  actor: string;
  actorKind: MigrationActorKind;
  auditRef: string;
  reason: string;
};

type BackfillCheckpoint = {
  completed_at: string;
  created_at: string;
  created_work_ids: string[];
  cursor: number;
  issue_ids: number[];
  operation: "backfill";
  run_id: string;
  schema_version: typeof WORK_BACKFILL_CHECKPOINT_SCHEMA_VERSION;
  source_sha256: string;
  status: "complete" | "in_progress" | "paused";
};

type RollbackCheckpoint = {
  backfill_checkpoint_sha256: string;
  completed_at: string;
  created_at: string;
  cursor: number;
  deleted_work_ids: string[];
  operation: "rollback";
  run_id: string;
  schema_version: typeof WORK_ROLLBACK_CHECKPOINT_SCHEMA_VERSION;
  status: "complete" | "in_progress" | "paused";
  work_ids: string[];
};

type ConsistencyDetail = {
  issue_id?: number;
  legacy_status?: string;
  mismatches: string[];
  status: "mismatch" | "missing_target" | "orphan_target";
  target_revision?: number;
  target_status?: string;
  work_id: string;
};

type RepairProposal = {
  action: "backfill_missing_target" | "review_orphan_target" | "sync_target_from_issue_after_review";
  authority: "issues";
  destructive: false;
  fields: string[];
  issue_id?: number;
  work_id: string;
};

export type WorkConsistencyReport = {
  counts: {
    issues: number;
    matched: number;
    mismatched: number;
    missing_target: number;
    orphan_target: number;
    target_issue_works: number;
  };
  database: { file: string; quick_check: string };
  details: ConsistencyDetail[];
  dual_read: { authority: "issues"; mode: "legacy_primary_target_comparison"; winner: "legacy" };
  generated_at: string;
  operation: "work_consistency_audit";
  parity_passed: boolean;
  policy: typeof WORK_MIGRATION_POLICY;
  repair_proposals: RepairProposal[];
  schema_version: typeof WORK_CONSISTENCY_REPORT_SCHEMA_VERSION;
  source_sha256: string;
  source_status_counts: Record<string, number>;
  target_status_counts: Record<string, number>;
};

export type WorkBackfillInput = {
  actor?: string;
  actorKind?: MigrationActorKind;
  apply?: boolean;
  auditRef?: string;
  batchSize?: number;
  checkpointPath: string;
  confirmBackupTested?: boolean;
  confirmNoActiveWriters?: boolean;
  dbPath: string;
  maxBatches?: number;
  reason?: string;
  reportPath: string;
  resume?: boolean;
};

export type WorkRollbackInput = Omit<WorkBackfillInput, "checkpointPath"> & {
  backfillCheckpointPath: string;
  checkpointPath: string;
};

export function auditWorkConsistency(input: {
  dbPath: string;
  reportPath?: string;
}): WorkConsistencyReport {
  const dbPath = existingDatabasePath(input.dbPath);
  if (input.reportPath && resolve(input.reportPath) === dbPath) {
    throw new Error("consistency report path must be different from the database path");
  }
  const sqlite = openReadonly(dbPath);
  const db = databaseAdapter(sqlite, dbPath, true);
  try {
    assertWorkMigrationSchema(sqlite);
    const report = consistencyReport(db);
    if (input.reportPath) writeJSON(input.reportPath, report);
    return report;
  } finally {
    sqlite.close();
  }
}

export function backfillIssueWorks(input: WorkBackfillInput): Record<string, unknown> {
  const dbPath = existingDatabasePath(input.dbPath);
  const checkpointPath = resolve(input.checkpointPath);
  if (new Set([dbPath, checkpointPath, resolve(input.reportPath)]).size !== 3) {
    throw new Error("database, backfill checkpoint, and report paths must be different");
  }
  const sqlite = input.apply ? openWritable(dbPath) : openReadonly(dbPath);
  const db = databaseAdapter(sqlite, dbPath, !input.apply);
  let checkpoint: BackfillCheckpoint | undefined;
  let authorization: MigrationAuthorization | undefined;
  try {
    assertWorkMigrationSchema(sqlite);
    const before = consistencyReport(db);
    const selection = issueSelection(db);
    if (!input.apply) {
      const report = backfillReport(dbPath, before, before, {
        checkpoint: {
          cursor: 0,
          path: checkpointPath,
          status: "not_created",
          total: selection.issueIDs.length
        },
        dryRun: true,
        paused: false,
        resume: false
      });
      writeJSON(input.reportPath, report);
      return report;
    }

    authorization = validateAuthorization(input);
    requireWriteConfirmations(input);
    if (input.resume) {
      checkpoint = readBackfillCheckpoint(checkpointPath);
      verifyBackfillCheckpoint(checkpoint, selection);
    } else {
      if (existsSync(checkpointPath)) {
        throw new Error("backfill checkpoint already exists; pass --resume or choose a new checkpoint path");
      }
      checkpoint = {
        completed_at: "",
        created_at: new Date().toISOString(),
        created_work_ids: [],
        cursor: 0,
        issue_ids: selection.issueIDs,
        operation: "backfill",
        run_id: randomUUID(),
        schema_version: WORK_BACKFILL_CHECKPOINT_SCHEMA_VERSION,
        source_sha256: selection.sourceSha256,
        status: "in_progress"
      };
      writeJSON(checkpointPath, checkpoint);
    }

    const actionID = `work-backfill:${checkpoint.run_id}`;
    recordMigrationAudit(sqlite, actionID, authorization, input.resume
      ? "work_migration.backfill_resumed"
      : "work_migration.backfill_started", "allow", checkpointSummary(checkpoint));
    const batchSize = batchSizeValue(input.batchSize);
    const created = new Set(checkpoint.created_work_ids);
    let batches = 0;
    while (checkpoint.cursor < checkpoint.issue_ids.length) {
      const issueIDs = checkpoint.issue_ids.slice(checkpoint.cursor, checkpoint.cursor + batchSize);
      db.transaction(() => {
        for (const issueID of issueIDs) {
          const pair = readIssueWorkDual(db, issueID);
          if (!pair) throw new Error(`Issue ${issueID} disappeared during backfill`);
          if (pair.status === "missing_target") {
            const result = syncIssueWorkShadow(db, issueID, backfillAudit(checkpoint!, authorization!, issueID));
            if (result.status !== "created" && result.status !== "matched") {
              throw new Error(`Issue ${issueID} Work backfill failed: ${result.mismatches.join(", ")}`);
            }
          }
          if (getWorkEvent(db, backfillCreateEventID(checkpoint!.run_id, issueID))) {
            created.add(issueIDToWorkID(issueID));
          }
        }
      }).immediate();
      checkpoint.cursor += issueIDs.length;
      checkpoint.created_work_ids = canonicalWorkIDSort([...created]);
      checkpoint.status = "in_progress";
      writeJSON(checkpointPath, checkpoint);
      batches += 1;
      if (input.maxBatches !== undefined && batches >= positiveInteger(input.maxBatches, "max batches") &&
          checkpoint.cursor < checkpoint.issue_ids.length) {
        checkpoint.status = "paused";
        writeJSON(checkpointPath, checkpoint);
        recordMigrationAudit(sqlite, actionID, authorization, "work_migration.backfill_paused", "allow", checkpointSummary(checkpoint));
        const after = consistencyReport(db);
        const report = backfillReport(dbPath, before, after, {
          checkpoint: { ...checkpointSummary(checkpoint), path: checkpointPath },
          dryRun: false,
          paused: true,
          resume: Boolean(input.resume)
        });
        writeJSON(input.reportPath, report);
        return report;
      }
    }

    checkpoint.status = "complete";
    checkpoint.completed_at = new Date().toISOString();
    writeJSON(checkpointPath, checkpoint);
    const after = consistencyReport(db);
    recordMigrationAudit(sqlite, actionID, authorization, "work_migration.backfill_completed",
      after.parity_passed ? "allow" : "deny", { ...checkpointSummary(checkpoint), parity_passed: after.parity_passed });
    const report = backfillReport(dbPath, before, after, {
      checkpoint: { ...checkpointSummary(checkpoint), path: checkpointPath },
      dryRun: false,
      paused: false,
      resume: Boolean(input.resume)
    });
    writeJSON(input.reportPath, report);
    return report;
  } catch (error) {
    if (input.apply && authorization && checkpoint) {
      try {
        recordMigrationAudit(sqlite, `work-backfill:${checkpoint.run_id}`, authorization,
          "work_migration.backfill_failed", "deny", { error: errorMessage(error), ...checkpointSummary(checkpoint) });
      } catch {
        // Preserve the migration failure if audit persistence also fails.
      }
    }
    throw error;
  } finally {
    sqlite.close();
  }
}

export function rollbackIssueWorkBackfill(input: WorkRollbackInput): Record<string, unknown> {
  const dbPath = existingDatabasePath(input.dbPath);
  const backfillPath = resolve(input.backfillCheckpointPath);
  const rollbackPath = resolve(input.checkpointPath);
  const reportPath = resolve(input.reportPath);
  if (new Set([dbPath, backfillPath, rollbackPath, reportPath]).size !== 4) {
    throw new Error("database, backfill checkpoint, rollback checkpoint, and report paths must be different");
  }
  const backfillText = readFileSync(backfillPath, "utf8");
  const backfill = parseBackfillCheckpoint(backfillText);
  const backfillSha256 = sha256(backfillText);
  const sqlite = input.apply ? openWritable(dbPath) : openReadonly(dbPath);
  const db = databaseAdapter(sqlite, dbPath, !input.apply);
  let checkpoint: RollbackCheckpoint | undefined;
  let authorization: MigrationAuthorization | undefined;
  try {
    assertWorkMigrationSchema(sqlite);
    const before = consistencyReport(db);
    const workIDs = rollbackCandidates(db, backfill);
    const blockers = rollbackBlockers(db, backfill, workIDs);
    if (!input.apply) {
      const report = rollbackReport(dbPath, before, before, blockers, {
        checkpoint: { cursor: 0, path: rollbackPath, status: "not_created", total: workIDs.length },
        dryRun: true,
        paused: false,
        resume: false
      });
      writeJSON(input.reportPath, report);
      return report;
    }

    authorization = validateAuthorization(input);
    requireWriteConfirmations(input);
    if (blockers.length > 0) {
      throw new Error(`rollback blocked for ${blockers.length} Work rows; run dry-run and review the report`);
    }
    if (input.resume) {
      checkpoint = readRollbackCheckpoint(rollbackPath);
      verifyRollbackCheckpoint(checkpoint, backfillSha256, workIDs);
    } else {
      if (existsSync(rollbackPath)) {
        throw new Error("rollback checkpoint already exists; pass --resume or choose a new checkpoint path");
      }
      checkpoint = {
        backfill_checkpoint_sha256: backfillSha256,
        completed_at: "",
        created_at: new Date().toISOString(),
        cursor: 0,
        deleted_work_ids: [],
        operation: "rollback",
        run_id: randomUUID(),
        schema_version: WORK_ROLLBACK_CHECKPOINT_SCHEMA_VERSION,
        status: "in_progress",
        work_ids: workIDs
      };
      writeJSON(rollbackPath, checkpoint);
    }

    const actionID = `work-rollback:${checkpoint.run_id}`;
    recordMigrationAudit(sqlite, actionID, authorization, input.resume
      ? "work_migration.rollback_resumed"
      : "work_migration.rollback_started", "allow", rollbackCheckpointSummary(checkpoint));
    const batchSize = batchSizeValue(input.batchSize);
    const deleted = new Set(checkpoint.deleted_work_ids);
    let batches = 0;
    while (checkpoint.cursor < checkpoint.work_ids.length) {
      const ids = checkpoint.work_ids.slice(checkpoint.cursor, checkpoint.cursor + batchSize);
      db.transaction(() => {
        for (const workID of ids) {
          const current = getWork(db, workID as WorkLedgerEntry["id"]);
          if (!current) {
            deleted.add(workID);
            continue;
          }
          const blocker = rollbackBlocker(db, backfill, workID);
          if (blocker) throw new Error(`${workID} rollback blocked: ${blocker}`);
          const result = db.sqlite.run("delete from works where id=?", [workID]);
          if (Number(result.changes) < 1 || getWork(db, workID as WorkLedgerEntry["id"])) {
            throw new Error(`${workID} changed during rollback`);
          }
          deleted.add(workID);
        }
      }).immediate();
      checkpoint.cursor += ids.length;
      checkpoint.deleted_work_ids = canonicalWorkIDSort([...deleted]);
      checkpoint.status = "in_progress";
      writeJSON(rollbackPath, checkpoint);
      batches += 1;
      if (input.maxBatches !== undefined && batches >= positiveInteger(input.maxBatches, "max batches") &&
          checkpoint.cursor < checkpoint.work_ids.length) {
        checkpoint.status = "paused";
        writeJSON(rollbackPath, checkpoint);
        recordMigrationAudit(sqlite, actionID, authorization, "work_migration.rollback_paused", "allow",
          rollbackCheckpointSummary(checkpoint));
        const after = consistencyReport(db);
        const report = rollbackReport(dbPath, before, after, [], {
          checkpoint: { ...rollbackCheckpointSummary(checkpoint), path: rollbackPath },
          dryRun: false,
          paused: true,
          resume: Boolean(input.resume)
        });
        writeJSON(input.reportPath, report);
        return report;
      }
    }

    checkpoint.status = "complete";
    checkpoint.completed_at = new Date().toISOString();
    writeJSON(rollbackPath, checkpoint);
    const after = consistencyReport(db);
    recordMigrationAudit(sqlite, actionID, authorization, "work_migration.rollback_completed", "allow", {
      ...rollbackCheckpointSummary(checkpoint),
      quick_check: after.database.quick_check
    });
    const report = rollbackReport(dbPath, before, after, [], {
      checkpoint: { ...rollbackCheckpointSummary(checkpoint), path: rollbackPath },
      dryRun: false,
      paused: false,
      resume: Boolean(input.resume)
    });
    writeJSON(input.reportPath, report);
    return report;
  } catch (error) {
    if (input.apply && authorization && checkpoint) {
      try {
        recordMigrationAudit(sqlite, `work-rollback:${checkpoint.run_id}`, authorization,
          "work_migration.rollback_failed", "deny", { error: errorMessage(error), ...rollbackCheckpointSummary(checkpoint) });
      } catch {
        // Preserve the rollback failure if audit persistence also fails.
      }
    }
    throw error;
  } finally {
    sqlite.close();
  }
}

function consistencyReport(db: RunnerDatabase): WorkConsistencyReport {
  const issues = listIssues(db).sort((left, right) => left.id - right.id);
  const issueIDs = new Set(issues.map((issue) => issue.id));
  const details: ConsistencyDetail[] = [];
  const proposals: RepairProposal[] = [];
  const sourceStatuses: Record<string, number> = {};
  const targetStatuses: Record<string, number> = {};
  const sourceForHash: WorkLedgerEntry[] = [];
  let matched = 0;
  let mismatched = 0;
  let missingTarget = 0;

  for (const issue of issues) {
    const pair = readIssueWorkDual(db, issue.id);
    if (!pair) throw new Error(`Issue ${issue.id} disappeared during consistency audit`);
    sourceForHash.push(pair.legacy);
    increment(sourceStatuses, pair.legacy.status);
    if (pair.target) increment(targetStatuses, pair.target.status);
    if (pair.status === "matched") {
      matched += 1;
      continue;
    }
    if (pair.status === "missing_target") {
      missingTarget += 1;
      details.push({
        issue_id: issue.id,
        legacy_status: pair.legacy.status,
        mismatches: pair.mismatches,
        status: "missing_target",
        work_id: pair.legacy.id
      });
      proposals.push({
        action: "backfill_missing_target",
        authority: "issues",
        destructive: false,
        fields: pair.mismatches,
        issue_id: issue.id,
        work_id: pair.legacy.id
      });
      continue;
    }
    mismatched += 1;
    details.push({
      issue_id: issue.id,
      legacy_status: pair.legacy.status,
      mismatches: pair.mismatches,
      status: "mismatch",
      target_revision: pair.target?.revision,
      target_status: pair.target?.status,
      work_id: pair.legacy.id
    });
    proposals.push({
      action: "sync_target_from_issue_after_review",
      authority: "issues",
      destructive: false,
      fields: pair.mismatches,
      issue_id: issue.id,
      work_id: pair.legacy.id
    });
  }

  const issueTargets = listWorks(db).filter((work) => work.id.startsWith("xw:work:issues:"));
  const orphans = issueTargets.filter((work) => {
    const mappedIssueID = issueID(work.id);
    return mappedIssueID === undefined || !issueIDs.has(mappedIssueID);
  });
  for (const work of orphans) {
    increment(targetStatuses, work.status);
    details.push({
      mismatches: ["legacy_missing"],
      status: "orphan_target",
      target_revision: work.revision,
      target_status: work.status,
      work_id: work.id
    });
    proposals.push({
      action: "review_orphan_target",
      authority: "issues",
      destructive: false,
      fields: ["legacy_missing"],
      work_id: work.id
    });
  }

  const integrity = quickCheck(db.sqlite);
  return {
    counts: {
      issues: issues.length,
      matched,
      mismatched,
      missing_target: missingTarget,
      orphan_target: orphans.length,
      target_issue_works: issueTargets.length
    },
    database: { file: db.path, quick_check: integrity },
    details,
    dual_read: { authority: "issues", mode: "legacy_primary_target_comparison", winner: "legacy" },
    generated_at: new Date().toISOString(),
    operation: "work_consistency_audit",
    parity_passed: integrity === "ok" && missingTarget === 0 && mismatched === 0 && orphans.length === 0,
    policy: WORK_MIGRATION_POLICY,
    repair_proposals: proposals,
    schema_version: WORK_CONSISTENCY_REPORT_SCHEMA_VERSION,
    source_sha256: sha256(stableJSON(sourceForHash)),
    source_status_counts: sortedCounts(sourceStatuses),
    target_status_counts: sortedCounts(targetStatuses)
  };
}

function issueSelection(db: RunnerDatabase): { issueIDs: number[]; sourceSha256: string } {
  const report = consistencyReport(db);
  const issueIDs = listIssues(db).map((issue) => issue.id).sort((left, right) => left - right);
  return { issueIDs, sourceSha256: report.source_sha256 };
}

function backfillReport(
  dbPath: string,
  before: WorkConsistencyReport,
  after: WorkConsistencyReport,
  input: { checkpoint: Record<string, unknown>; dryRun: boolean; paused: boolean; resume: boolean }
): Record<string, unknown> {
  return {
    schema_version: "xuanwu.work-backfill-report.v1",
    operation: "work_backfill",
    generated_at: new Date().toISOString(),
    database: dbPath,
    dry_run: input.dryRun,
    paused: input.paused,
    resume: input.resume,
    source_of_truth: "issues",
    target_role: "shadow",
    policy: WORK_MIGRATION_POLICY,
    checkpoint: input.checkpoint,
    before,
    after,
    created_rows: after.counts.target_issue_works - before.counts.target_issue_works,
    parity_passed: after.parity_passed,
    repair_proposals: after.repair_proposals,
    rollback: "maintenance work rollback --backfill-checkpoint <path> --checkpoint <path>"
  };
}

function rollbackReport(
  dbPath: string,
  before: WorkConsistencyReport,
  after: WorkConsistencyReport,
  blockers: Array<{ reason: string; work_id: string }>,
  input: { checkpoint: Record<string, unknown>; dryRun: boolean; paused: boolean; resume: boolean }
): Record<string, unknown> {
  return {
    schema_version: "xuanwu.work-rollback-report.v1",
    operation: "work_backfill_rollback",
    generated_at: new Date().toISOString(),
    database: dbPath,
    dry_run: input.dryRun,
    paused: input.paused,
    resume: input.resume,
    destructive_scope: "unchanged_shadow_rows_created_by_selected_backfill_run_only",
    source_of_truth: "issues",
    policy: WORK_MIGRATION_POLICY,
    checkpoint: input.checkpoint,
    blockers,
    before,
    after,
    removed_rows: before.counts.target_issue_works - after.counts.target_issue_works
  };
}

function rollbackCandidates(db: RunnerDatabase, checkpoint: BackfillCheckpoint): string[] {
  const candidates = new Set(checkpoint.created_work_ids);
  for (const issueID of checkpoint.issue_ids) {
    if (getWorkEvent(db, backfillCreateEventID(checkpoint.run_id, issueID))) {
      candidates.add(issueIDToWorkID(issueID));
    }
  }
  return canonicalWorkIDSort([...candidates]);
}

function rollbackBlockers(
  db: RunnerDatabase,
  checkpoint: BackfillCheckpoint,
  workIDs: string[]
): Array<{ reason: string; work_id: string }> {
  return workIDs.flatMap((workID) => {
    const blocker = rollbackBlocker(db, checkpoint, workID);
    return blocker ? [{ reason: blocker, work_id: workID }] : [];
  });
}

function rollbackBlocker(db: RunnerDatabase, checkpoint: BackfillCheckpoint, workID: string): string | undefined {
  const work = getWork(db, workID as WorkLedgerEntry["id"]);
  if (!work) return undefined;
  const issueIDValue = issueID(workID);
  if (issueIDValue === undefined || !checkpoint.issue_ids.includes(issueIDValue)) {
    return "Work is not bound to the selected backfill Issue set";
  }
  const expectedEventID = backfillCreateEventID(checkpoint.run_id, issueIDValue);
  const events = listWorkEvents(db, work.id);
  if (events.length !== 1 || events[0]?.event_id !== expectedEventID || events[0]?.event_type !== "work.created.v1") {
    return "Work changed after backfill or was not created by the selected run";
  }
  if (stableJSON(events[0]?.payload.after) !== stableJSON(work)) {
    return "Work row no longer matches its backfill creation audit";
  }
  const relationCount = db.sqlite.query<{ count: number }, [string, string]>(`
    select count(*) as count from work_relations where source_work_id=? or target_work_id=?
  `).get(workID, workID)?.count ?? 0;
  if (relationCount > 0) return "Work has target relations";
  return undefined;
}

function backfillAudit(
  checkpoint: BackfillCheckpoint,
  authorization: MigrationAuthorization,
  issueID: number
): WorkTransitionAudit {
  return {
    actor: { id: authorization.actor, kind: authorization.actorKind },
    correlation_id: `work-backfill:${checkpoint.run_id}`,
    event_id: `work-backfill:${checkpoint.run_id}:issue:${issueID}`,
    gate: {
      authority: "deterministic_policy",
      decision: "allow",
      policy_ref: `xuanwu-work-backfill-v1:${authorization.auditRef}`
    },
    occurred_at: checkpoint.created_at,
    reason: authorization.reason
  };
}

function backfillCreateEventID(runID: string, issueID: number): string {
  return `work-backfill:${runID}:issue:${issueID}:shadow:create`;
}

function recordMigrationAudit(
  sqlite: SQLiteDatabase,
  actionID: string,
  authorization: MigrationAuthorization,
  eventType: string,
  decision: string,
  result: Record<string, unknown>
): void {
  recordMaintenanceAudit(sqlite, {
    actionID,
    actor: authorization.actor,
    decision,
    eventType,
    reason: authorization.reason,
    result: { actor_kind: authorization.actorKind, audit_ref: authorization.auditRef, ...result }
  });
}

function validateAuthorization(input: WorkBackfillInput): MigrationAuthorization {
  const actor = requiredText(input.actor, "--actor");
  if (actor.toLowerCase() === "llm") throw new Error("--actor cannot be llm");
  const actorKind = input.actorKind;
  if (actorKind !== "automation" && actorKind !== "system" && actorKind !== "user") {
    throw new Error("--actor-kind must be user, system, or automation");
  }
  return {
    actor,
    actorKind,
    auditRef: requiredText(input.auditRef, "--audit-ref"),
    reason: requiredText(input.reason, "--reason")
  };
}

function requireWriteConfirmations(input: {
  confirmBackupTested?: boolean;
  confirmNoActiveWriters?: boolean;
}): void {
  if (!input.confirmBackupTested) throw new Error("--confirm-backup-tested is required for apply mode");
  if (!input.confirmNoActiveWriters) throw new Error("--confirm-no-active-writers is required for apply mode");
}

function readBackfillCheckpoint(path: string): BackfillCheckpoint {
  if (!existsSync(path)) throw new Error("resume backfill checkpoint does not exist");
  const checkpoint = parseBackfillCheckpoint(readFileSync(path, "utf8"));
  if (checkpoint.status === "complete") throw new Error("backfill checkpoint is already complete");
  return checkpoint;
}

function parseBackfillCheckpoint(text: string): BackfillCheckpoint {
  const checkpoint = JSON.parse(text) as BackfillCheckpoint;
  if (checkpoint.schema_version !== WORK_BACKFILL_CHECKPOINT_SCHEMA_VERSION || checkpoint.operation !== "backfill") {
    throw new Error("backfill checkpoint is incompatible");
  }
  if (!Number.isSafeInteger(checkpoint.cursor) || checkpoint.cursor < 0 || checkpoint.cursor > checkpoint.issue_ids.length) {
    throw new Error("backfill checkpoint cursor is invalid");
  }
  return checkpoint;
}

function verifyBackfillCheckpoint(
  checkpoint: BackfillCheckpoint,
  selection: { issueIDs: number[]; sourceSha256: string }
): void {
  if (checkpoint.source_sha256 !== selection.sourceSha256 ||
      stableJSON(checkpoint.issue_ids) !== stableJSON(selection.issueIDs)) {
    throw new Error("backfill source changed since checkpoint creation");
  }
}

function readRollbackCheckpoint(path: string): RollbackCheckpoint {
  if (!existsSync(path)) throw new Error("resume rollback checkpoint does not exist");
  const checkpoint = JSON.parse(readFileSync(path, "utf8")) as RollbackCheckpoint;
  if (checkpoint.schema_version !== WORK_ROLLBACK_CHECKPOINT_SCHEMA_VERSION || checkpoint.operation !== "rollback") {
    throw new Error("rollback checkpoint is incompatible");
  }
  if (!Number.isSafeInteger(checkpoint.cursor) || checkpoint.cursor < 0 || checkpoint.cursor > checkpoint.work_ids.length) {
    throw new Error("rollback checkpoint cursor is invalid");
  }
  if (checkpoint.status === "complete") throw new Error("rollback checkpoint is already complete");
  return checkpoint;
}

function verifyRollbackCheckpoint(
  checkpoint: RollbackCheckpoint,
  backfillSha256: string,
  workIDs: string[]
): void {
  if (checkpoint.backfill_checkpoint_sha256 !== backfillSha256 ||
      stableJSON(checkpoint.work_ids) !== stableJSON(workIDs)) {
    throw new Error("rollback inputs changed since checkpoint creation");
  }
}

function checkpointSummary(checkpoint: BackfillCheckpoint): Record<string, unknown> {
  return {
    created_rows: checkpoint.created_work_ids.length,
    cursor: checkpoint.cursor,
    run_id: checkpoint.run_id,
    status: checkpoint.status,
    total: checkpoint.issue_ids.length
  };
}

function rollbackCheckpointSummary(checkpoint: RollbackCheckpoint): Record<string, unknown> {
  return {
    cursor: checkpoint.cursor,
    deleted_rows: checkpoint.deleted_work_ids.length,
    run_id: checkpoint.run_id,
    status: checkpoint.status,
    total: checkpoint.work_ids.length
  };
}

function assertWorkMigrationSchema(sqlite: SQLiteDatabase): void {
  for (const table of ["issues", "issue_events", "pi_action_events", "works", "work_events", "work_relations"]) {
    const exists = sqlite.query<{ name: string }, [string]>(
      "select name from sqlite_master where type='table' and name=?"
    ).get(table);
    if (!exists) throw new Error(`${table} is required; complete XW P02.04/P02.05/P02.06 migrations first`);
  }
}

function databaseAdapter(sqlite: SQLiteDatabase, path: string, readonly: boolean): RunnerDatabase {
  return {
    close: () => sqlite.close(),
    path,
    readonly,
    sqlite,
    transaction: (inside) => sqlite.transaction(inside)
  };
}

function openReadonly(path: string): SQLiteDatabase {
  const sqlite = new SQLiteDatabase(path, { create: false, readonly: true, strict: true });
  sqlite.run("pragma foreign_keys=on");
  return sqlite;
}

function openWritable(path: string): SQLiteDatabase {
  const sqlite = new SQLiteDatabase(path, { create: false, readwrite: true, strict: true });
  sqlite.run("pragma foreign_keys=on");
  return sqlite;
}

function existingDatabasePath(path: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    throw new Error(`database file does not exist: ${absolute}`);
  }
  return absolute;
}

function writeJSON(path: string, value: unknown): void {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, absolute);
}

function issueID(workID: string): number | undefined {
  try {
    return workIDToIssueID(workID);
  } catch {
    return undefined;
  }
}

function canonicalWorkIDSort(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => (issueID(left) ?? 0) - (issueID(right) ?? 0));
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function sortedCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function batchSizeValue(value: number | undefined): number {
  const result = value ?? 500;
  if (!Number.isSafeInteger(result) || result < 1 || result > 5000) {
    throw new Error("batch size must be from 1 to 5000");
  }
  return result;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function requiredText(value: string | undefined, label: string): string {
  const text = value?.trim() ?? "";
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableJSON(value: unknown): string {
  return JSON.stringify(sortJSON(value));
}

function sortJSON(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJSON);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, sortJSON(item)]));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
