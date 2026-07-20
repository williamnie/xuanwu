import { randomUUID } from "node:crypto";
import { Database as SQLiteDatabase } from "bun:sqlite";
import type { RunnerDatabase } from "../db/database.ts";
import { runMigrations } from "../db/migrations.ts";
import { compactEventSummaryProjectionMigration } from "../db/schema/054_compact_event_summary_projection.ts";
import { recordMaintenanceAudit } from "../db/repositories/eventMaintenance.ts";
import { eventProjectionStatus, listEventSummaryProjection } from "../db/repositories/eventSummaryProjection.ts";
import {
  assertProjectionParity,
  clearCompactEventSummaryProjection,
  compactProjectionStatus,
  getEventSummaryProjectionSwitch,
  listCompactEventSummaryProjection,
  projectPendingCompactEventSummaries,
  updateEventSummaryProjectionSwitch
} from "../db/repositories/compactEventSummaryProjection.ts";

const MAX_PROJECTION_BYTES = 100 * 1024 * 1024;
const DEFAULT_OBSERVATION_SECONDS = 24 * 60 * 60;
const DEFAULT_PERFORMANCE_SAMPLES = 20;

type Authorization = {
  actor: string;
  actorKind: "retention_worker" | "system" | "user";
  auditRef: string;
  reason: string;
};

type DatabaseInput = { dbPath: string };
type AuthorizedDatabaseInput = DatabaseInput & Authorization;

export function rebuildCompactEventSummaryProjection(
  input: AuthorizedDatabaseInput & { batchSize?: number; maxBatches?: number; resume?: boolean }
): Record<string, unknown> {
  const authorization = validatedAuthorization(input);
  return withDatabase(input.dbPath, (db) => {
    const actionID = `compact-event-summary-rebuild:${randomUUID()}`;
    const before = compactProjectionStatus(db);
    try {
      audit(db, actionID, authorization, "event_summary_projection.compact_rebuild_started", "allow", { before });
      if (!input.resume) {
        assertShadowRebuildAllowed(getEventSummaryProjectionSwitch(db));
        clearCompactEventSummaryProjection(db);
      }
      const projection = projectPendingCompactEventSummaries(db, {
        batchSize: input.batchSize,
        maxBatches: input.maxBatches
      });
      const after = compactProjectionStatus(db);
      audit(db, actionID, authorization, projection.paused
        ? "event_summary_projection.compact_rebuild_paused"
        : "event_summary_projection.compact_rebuild_completed", "allow", { after, projection });
      return {
        operation: "rebuild_compact_event_summary_projection",
        source_of_truth: "issue_events",
        destructive_scope: "none_shadow_only",
        resume: Boolean(input.resume),
        before,
        after,
        ...projection
      };
    } catch (error) {
      try {
        audit(db, actionID, authorization, "event_summary_projection.compact_rebuild_failed", "deny", {
          error: error instanceof Error ? error.message : String(error)
        });
      } catch {
        // Preserve the deterministic rebuild failure.
      }
      throw error;
    }
  });
}

export function verifyCompactEventSummaryProjection(
  input: DatabaseInput & { performanceSamples?: number }
): Record<string, unknown> {
  return withDatabase(input.dbPath, (db) => verifyCompactProjection(db, input.performanceSamples));
}

export function observeCompactEventSummaryProjection(
  input: AuthorizedDatabaseInput & {
    apply?: boolean;
    confirmBackupTested?: boolean;
    confirmNoActiveWriters?: boolean;
    durationSeconds?: number;
  }
): Record<string, unknown> {
  const authorization = validatedAuthorization(input);
  return withDatabase(input.dbPath, (db) => {
    const verification = verifyCompactProjection(db);
    const blockers = switchBlockers(input, verification);
    const before = getEventSummaryProjectionSwitch(db);
    if (!input.apply || blockers.length > 0) {
      return {
        operation: "observe_compact_event_summary_projection",
        dry_run: true,
        applied: false,
        blockers,
        before,
        verification
      };
    }
    const durationSeconds = nonNegativeInteger(input.durationSeconds ?? DEFAULT_OBSERVATION_SECONDS, "durationSeconds");
    const now = new Date();
    const after = updateEventSummaryProjectionSwitch(db, {
      cutover_at: before.cutover_at,
      expectedRevision: before.revision,
      observation_expires_at: new Date(now.getTime() + durationSeconds * 1000).toISOString(),
      observation_started_at: now.toISOString(),
      read_version: "v1",
      updatedAt: now.toISOString()
    });
    audit(db, `compact-event-summary-observe:${randomUUID()}`, authorization,
      "event_summary_projection.compact_observation_started", "allow", { after, before, verification });
    return { operation: "observe_compact_event_summary_projection", dry_run: false, applied: true, blockers, before, after, verification };
  });
}

export function cutoverCompactEventSummaryProjection(
  input: AuthorizedDatabaseInput & {
    apply?: boolean;
    confirmBackupTested?: boolean;
    confirmNoActiveWriters?: boolean;
    minimumObservationSeconds?: number;
  }
): Record<string, unknown> {
  const authorization = validatedAuthorization(input);
  return withDatabase(input.dbPath, (db) => {
    const verification = verifyCompactProjection(db);
    const before = getEventSummaryProjectionSwitch(db);
    const minimum = nonNegativeInteger(input.minimumObservationSeconds ?? DEFAULT_OBSERVATION_SECONDS, "minimumObservationSeconds");
    const blockers = [
      ...switchBlockers(input, verification),
      ...observationBlockers(before, minimum)
    ];
    if (!input.apply || blockers.length > 0) {
      return {
        operation: "cutover_compact_event_summary_projection",
        dry_run: true,
        applied: false,
        blockers,
        before,
        verification
      };
    }
    const at = new Date().toISOString();
    const after = updateEventSummaryProjectionSwitch(db, {
      cutover_at: at,
      expectedRevision: before.revision,
      observation_expires_at: before.observation_expires_at,
      observation_started_at: before.observation_started_at,
      read_version: "v2",
      updatedAt: at
    });
    audit(db, `compact-event-summary-cutover:${randomUUID()}`, authorization,
      "event_summary_projection.compact_cutover", "allow", { after, before, verification });
    return { operation: "cutover_compact_event_summary_projection", dry_run: false, applied: true, blockers, before, after, verification };
  });
}

export function rollbackCompactEventSummaryProjection(
  input: AuthorizedDatabaseInput & {
    apply?: boolean;
    confirmBackupTested?: boolean;
    confirmNoActiveWriters?: boolean;
  }
): Record<string, unknown> {
  const authorization = validatedAuthorization(input);
  return withDatabase(input.dbPath, (db) => {
    const before = getEventSummaryProjectionSwitch(db);
    const legacy = eventProjectionStatus(db);
    const blockers = [
      ...mutationConfirmationBlockers(input),
      ...(legacy.lag_rows === 0 ? [] : [`legacy projection lag is ${legacy.lag_rows}`])
    ];
    if (!input.apply || blockers.length > 0) {
      return { operation: "rollback_compact_event_summary_projection", dry_run: true, applied: false, blockers, before, legacy };
    }
    const at = new Date().toISOString();
    const after = updateEventSummaryProjectionSwitch(db, {
      cutover_at: before.cutover_at,
      expectedRevision: before.revision,
      observation_expires_at: before.observation_expires_at,
      observation_started_at: before.observation_started_at,
      read_version: "v1",
      updatedAt: at
    });
    audit(db, `compact-event-summary-rollback:${randomUUID()}`, authorization,
      "event_summary_projection.compact_rollback", "allow", { after, before, legacy });
    return { operation: "rollback_compact_event_summary_projection", dry_run: false, applied: true, blockers, before, after, legacy };
  });
}

function verifyCompactProjection(db: RunnerDatabase, performanceSamples = DEFAULT_PERFORMANCE_SAMPLES): Record<string, unknown> {
  const samples = positiveInteger(performanceSamples, "performanceSamples");
  const legacy = eventProjectionStatus(db);
  const compact = compactProjectionStatus(db);
  const coverage = {
    source_rows: scalar(db, "select count(*) as value from issue_events"),
    legacy_rows: scalar(db, "select count(*) as value from event_summary_projection"),
    compact_rows: scalar(db, "select count(*) as value from event_summary_projection_compact"),
    source_last_event_id: scalar(db, "select coalesce(max(id), 0) as value from issue_events"),
    legacy_last_event_id: scalar(db, "select coalesce(max(source_event_id), 0) as value from event_summary_projection"),
    compact_last_event_id: scalar(db, "select coalesce(max(source_event_id), 0) as value from event_summary_projection_compact")
  };
  const parity = fullParity(db, coverage.source_last_event_id);
  const storage = projectionStorage(db);
  const performance = projectionPerformance(db, samples);
  const blockers = [
    ...(legacy.lag_rows === 0 ? [] : [`legacy projection lag is ${legacy.lag_rows}`]),
    ...(compact.lag_rows === 0 ? [] : [`compact projection lag is ${compact.lag_rows}`]),
    ...(coverage.source_rows === coverage.legacy_rows && coverage.source_rows === coverage.compact_rows
      ? [] : ["projection row coverage differs from issue_events"]),
    ...(parity.mismatches === 0 ? [] : [`projection parity has ${parity.mismatches} mismatches`]),
    ...(storage.total_bytes <= MAX_PROJECTION_BYTES ? [] : [`compact projection uses ${storage.total_bytes} bytes`]),
    ...(performance.passed ? [] : [`compact projection worst P95 ratio is ${performance.worst_p95_ratio}`])
  ];
  return {
    contract: "xw.event-summary-compact-cutover.v1",
    source_of_truth: "issue_events",
    coverage,
    legacy,
    compact,
    parity,
    storage: { ...storage, maximum_bytes: MAX_PROJECTION_BYTES, passed: storage.total_bytes <= MAX_PROJECTION_BYTES },
    performance: { ...performance, maximum_p95_ratio: 1.2 },
    blockers,
    cutover_ready: blockers.length === 0,
    destructive_delete_gate: {
      authorized: false,
      legacy_rows_deleted: 0,
      required: [
        "consumer-zero",
        "fresh-backup-and-isolated-restore",
        "served-runtime-observation-window",
        "explicit-non-LLM-approval"
      ]
    }
  };
}

function fullParity(db: RunnerDatabase, sourceLastID: number): {
  batches: number;
  compared_rows: number;
  mismatch_samples: string[];
  mismatches: number;
  representation_differences: number;
} {
  let beforeID = sourceLastID + 1;
  let batches = 0;
  let comparedRows = 0;
  let mismatches = 0;
  const mismatchSamples: string[] = [];
  let representationDifferences = 0;
  while (beforeID > 1) {
    const filter = { beforeID, limit: 500 };
    const legacy = listEventSummaryProjection(db, filter);
    const compact = listCompactEventSummaryProjection(db, filter);
    if (legacy.length === 0 && compact.length === 0) break;
    try {
      assertProjectionParity(legacy, compact);
    } catch (error) {
      mismatches += 1;
      if (mismatchSamples.length < 20) mismatchSamples.push(error instanceof Error ? error.message : String(error));
    }
    for (let index = 0; index < Math.min(legacy.length, compact.length); index += 1) {
      if (legacy[index]!.source_payload_bytes !== compact[index]!.source_payload_bytes ||
          legacy[index]!.source_sha256 !== compact[index]!.source_sha256) representationDifferences += 1;
    }
    const ids = [...legacy, ...compact].map((row) => row.source_event_id);
    if (ids.length === 0) break;
    beforeID = Math.min(...ids);
    comparedRows += Math.max(legacy.length, compact.length);
    batches += 1;
  }
  return {
    batches,
    compared_rows: comparedRows,
    mismatch_samples: mismatchSamples,
    mismatches,
    representation_differences: representationDifferences
  };
}

function projectionStorage(db: RunnerDatabase): { objects: Array<{ bytes: number; name: string }>; total_bytes: number } {
  const names = [
    "event_summary_projection_compact",
    "event_summary_projection_compat_modes",
    "event_summary_projection_payloads",
    "event_summary_projection_projects",
    "event_summary_projection_runs",
    "event_summary_projection_types",
    "idx_event_summary_projection_compact_issue",
    "idx_event_summary_projection_compact_project",
    "sqlite_autoindex_event_summary_projection_payloads_1",
    "sqlite_autoindex_event_summary_projection_projects_1",
    "sqlite_autoindex_event_summary_projection_runs_1",
    "sqlite_autoindex_event_summary_projection_types_1"
  ];
  const rows = db.sqlite.query<{ bytes: number; name: string }, string[]>(`
    select name, sum(pgsize) as bytes from dbstat
    where name in (${names.map(() => "?").join(",")}) group by name order by bytes desc
  `).all(...names).map((row) => ({ bytes: Number(row.bytes), name: String(row.name) }));
  return { objects: rows, total_bytes: rows.reduce((total, row) => total + row.bytes, 0) };
}

function projectionPerformance(db: RunnerDatabase, samples: number): {
  passed: boolean;
  workloads: Array<Record<string, unknown>>;
  worst_p95_ratio: number;
} {
  const busiestIssue = db.sqlite.query<{ issue_id: number }, []>(`
    select issue_id from event_summary_projection group by issue_id order by count(*) desc limit 1
  `).get()?.issue_id;
  const busiestProject = db.sqlite.query<{ project_id: string }, []>(`
    select project_id from event_summary_projection group by project_id order by count(*) desc limit 1
  `).get()?.project_id;
  const workloads = [
    {
      name: "latest_50",
      filter: { limit: 50 },
      legacySql: "select source_event_id from event_summary_projection where source='issue_events' order by source_event_id desc limit 50",
      compactSql: "select source_event_id from event_summary_projection_compact order by source_event_id desc limit 50",
      args: [] as Array<number | string>
    },
    ...(busiestIssue ? [{
      name: "issue_latest_500",
      filter: { issueID: Number(busiestIssue), limit: 500 },
      legacySql: "select source_event_id from event_summary_projection where source='issue_events' and issue_id=? order by source_event_id desc limit 500",
      compactSql: "select source_event_id from event_summary_projection_compact where issue_id=? order by source_event_id desc limit 500",
      args: [Number(busiestIssue)]
    }] : []),
    ...(busiestProject ? [{
      name: "project_latest_100",
      filter: { projectID: String(busiestProject), limit: 100 },
      legacySql: "select source_event_id from event_summary_projection where source='issue_events' and project_id=? order by source_event_id desc limit 100",
      compactSql: `select source_event_id from event_summary_projection_compact
        where project_ref=(select project_ref from event_summary_projection_projects where project_id=?)
        order by source_event_id desc limit 100`,
      args: [String(busiestProject)]
    }] : [])
  ].map(({ name, filter, legacySql, compactSql, args }) => {
    queryIDs(db, legacySql, args);
    queryIDs(db, compactSql, args);
    const legacy = timings(samples, () => queryIDs(db, legacySql, args));
    const compact = timings(samples, () => queryIDs(db, compactSql, args));
    const legacyP95 = percentile95(legacy);
    const compactP95 = percentile95(compact);
    return {
      name,
      filter,
      legacy_p95_ms: round(legacyP95),
      compact_p95_ms: round(compactP95),
      gate_passed: compactP95 <= legacyP95 * 1.2 || compactP95 - legacyP95 <= 2,
      p95_ratio: round(legacyP95 === 0 ? 1 : compactP95 / legacyP95)
    };
  });
  return {
    passed: workloads.every((item) => Boolean(item.gate_passed)),
    workloads,
    worst_p95_ratio: Math.max(0, ...workloads.map((item) => Number(item.p95_ratio)))
  };
}

function queryIDs(db: RunnerDatabase, sql: string, args: Array<number | string>): number[] {
  return db.sqlite.query<{ source_event_id: number }, Array<number | string>>(sql)
    .all(...args)
    .map((row) => Number(row.source_event_id));
}

function timings(samples: number, run: () => unknown): number[] {
  return Array.from({ length: samples }, () => {
    const started = performance.now();
    run();
    return performance.now() - started;
  });
}

function percentile95(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function switchBlockers(
  input: { confirmBackupTested?: boolean; confirmNoActiveWriters?: boolean },
  verification: Record<string, unknown>
): string[] {
  return [
    ...mutationConfirmationBlockers(input),
    ...((verification.blockers as string[] | undefined) ?? [])
  ];
}

function mutationConfirmationBlockers(input: {
  confirmBackupTested?: boolean;
  confirmNoActiveWriters?: boolean;
}): string[] {
  return [
    ...(input.confirmBackupTested ? [] : ["--confirm-backup-tested is required"]),
    ...(input.confirmNoActiveWriters ? [] : ["--confirm-no-active-writers is required"])
  ];
}

function observationBlockers(state: ReturnType<typeof getEventSummaryProjectionSwitch>, minimumSeconds: number): string[] {
  if (!state.observation_started_at || !state.observation_expires_at) return ["dual-read observation has not started"];
  const started = Date.parse(state.observation_started_at);
  const expires = Date.parse(state.observation_expires_at);
  const now = Date.now();
  if (!Number.isFinite(started) || !Number.isFinite(expires)) return ["dual-read observation timestamps are invalid"];
  return [
    ...(now - started >= minimumSeconds * 1000 ? [] : [`dual-read observation is shorter than ${minimumSeconds} seconds`]),
    ...(now <= expires ? [] : ["dual-read observation has expired"])
  ];
}

function assertShadowRebuildAllowed(state: ReturnType<typeof getEventSummaryProjectionSwitch>): void {
  if (state.read_version !== "v1") {
    throw new Error("compact projection rebuild is blocked while V2 is the active read version");
  }
  const expires = Date.parse(state.observation_expires_at);
  if (state.observation_started_at && Number.isFinite(expires) && Date.now() <= expires) {
    throw new Error("compact projection rebuild is blocked during dual-read observation");
  }
}

function withDatabase<T>(path: string, inside: (db: RunnerDatabase) => T): T {
  const dbPath = requiredText(path, "--db");
  const sqlite = new SQLiteDatabase(dbPath, { create: false, strict: true });
  sqlite.run("pragma foreign_keys = on");
  runMigrations(sqlite, [compactEventSummaryProjectionMigration]);
  const db: RunnerDatabase = {
    close: () => sqlite.close(),
    path: dbPath,
    readonly: false,
    sqlite,
    transaction: (callback) => sqlite.transaction(callback)
  };
  try {
    return inside(db);
  } finally {
    sqlite.close();
  }
}

function audit(
  db: RunnerDatabase,
  actionID: string,
  authorization: Authorization,
  eventType: string,
  decision: string,
  result: Record<string, unknown>
): void {
  recordMaintenanceAudit(db.sqlite, {
    actionID,
    actor: authorization.actor,
    decision,
    eventType,
    reason: authorization.reason,
    result: { actor_kind: authorization.actorKind, audit_ref: authorization.auditRef, ...result }
  });
}

function validatedAuthorization(input: Authorization): Authorization {
  const actor = requiredText(input.actor, "--actor");
  if (actor.toLowerCase() === "llm") throw new Error("--actor cannot be llm");
  if (!["retention_worker", "system", "user"].includes(input.actorKind)) {
    throw new Error("--actor-kind must be user, system, or retention_worker");
  }
  return {
    actor,
    actorKind: input.actorKind,
    auditRef: requiredText(input.auditRef, "--audit-ref"),
    reason: requiredText(input.reason, "--reason")
  };
}

function scalar(db: RunnerDatabase, sql: string): number {
  return Number(db.sqlite.query<{ value: number }, []>(sql).get()?.value ?? 0);
}

function requiredText(value: string, label: string): string {
  const text = value?.trim() ?? "";
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
