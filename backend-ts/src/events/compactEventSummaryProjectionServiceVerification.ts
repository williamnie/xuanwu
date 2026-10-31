import type { RunnerDatabase } from "../db/database.ts";
import { sqliteObjectUsage } from "../db/sqliteObjectUsage.ts";
import { eventProjectionStatus, listEventSummaryProjection } from "../db/repositories/eventSummaryProjection.ts";
import {
  assertProjectionParity,
  compactProjectionStatus,
  listCompactEventSummaryProjection
} from "../db/repositories/compactEventSummaryProjection.ts";
import { DEFAULT_PERFORMANCE_SAMPLES, MAX_PROJECTION_BYTES } from "./compactEventSummaryProjectionServiceModel.ts";
import { positiveInteger, scalar, round } from "./compactEventSummaryProjectionServiceAuthorization.ts";

export function verifyCompactProjection(db: RunnerDatabase, performanceSamples = DEFAULT_PERFORMANCE_SAMPLES): Record<string, unknown> {
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
  const rows = sqliteObjectUsage(db.sqlite, names);
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
