import { Database as SQLiteDatabase } from "bun:sqlite";
import { stat, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { listAutomations, getAutomationTrigger, listAutomationRuns } from "../db/repositories/automations.ts";
import { listAgentSessions } from "../db/repositories/agentSessions.ts";
import { listIssues } from "../db/repositories/issues.ts";
import { listProjects } from "../db/repositories/projects.ts";
import { listRuns } from "../db/repositories/runs.ts";
import { runProgressProjectionStatus } from "../db/repositories/runProgress.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { issueIDToWorkID } from "../domain/work/issueAdapter.ts";
import { queryWorkTimeline } from "../domain/work/timeline.ts";
import { projectPendingEventSummaries } from "../events/eventSummaryProjector.ts";
import {
  PROCESS_GROUP_MEMORY_BUDGETS,
  PROCESS_GROUP_MEMORY_METRIC_DEFINITIONS
} from "../observability/processGroupMemory.ts";

export const CAPACITY_REPORT_SCHEMA = "xuanwu.capacity-benchmark.v1" as const;

export const CAPACITY_BUDGETS = {
  database: {
    alert_bytes: 10 * 1024 * 1024 * 1024,
    raw_and_projection_bytes_per_event: 4 * 1024
  },
  latency_ms: {
    "automations.frontend_list_500": { p50: 250, p95: 500 },
    "issues.frontend_page_100": { p50: 50, p95: 100 },
    "projects.frontend_list": { p50: 20, p95: 50 },
    "runs.active_projection_8": { p50: 750, p95: 1_500 },
    "runs.frontend_page_100": { p50: 750, p95: 1_500 },
    "sessions.project_catalog": { p50: 100, p95: 250 },
    "timeline.long_session_first_60": { p50: 750, p95: 1_500 }
  },
  memory: {
    peak_rss_bytes: 512 * 1024 * 1024,
    rss_growth_bytes: 384 * 1024 * 1024,
    process_group: PROCESS_GROUP_MEMORY_BUDGETS
  },
  regression: { minimum_delta_ms: 5, p95_ratio: 1.25 }
} as const;

export const RUNNER_MEMORY_CAPACITY_PHASES = [
  "cold_start", "idle", "usage_first", "usage_warm", "run", "cancel",
  "failure_retry", "restart", "lifecycle", "post_ttl", "soak"
] as const;
export type RunnerMemoryCapacityPhase = typeof RUNNER_MEMORY_CAPACITY_PHASES[number];
export type RunnerMemoryCapacitySample = {
  cycle?: number;
  footprint_bytes?: number | null;
  freshness_status: string;
  group_rss_bytes: number;
  main_array_buffers_bytes?: number;
  main_external_bytes?: number;
  main_heap_used_bytes?: number;
  main_process_rss_bytes: number;
  main_ps_rss_bytes: number;
  observed_at: string;
  phase: RunnerMemoryCapacityPhase;
  sample_age_ms: number;
};
export type RunnerMemoryCapacityReport = {
  baseline_evidence_id: string;
  budgets: typeof PROCESS_GROUP_MEMORY_BUDGETS;
  group_p95_rss_bytes: { active_run: number; inactive: number; main_idle: number };
  lifecycle: { cycles: number; monotonic_growth: boolean; status: "passed" | "failed" };
  metric_definitions: typeof PROCESS_GROUP_MEMORY_METRIC_DEFINITIONS;
  missing_phases: RunnerMemoryCapacityPhase[];
  phase_p95_footprint_bytes: Partial<Record<RunnerMemoryCapacityPhase, number>>;
  phase_p95_main_memory_bytes: {
    array_buffers: Partial<Record<RunnerMemoryCapacityPhase, number>>;
    external: Partial<Record<RunnerMemoryCapacityPhase, number>>;
    heap_used: Partial<Record<RunnerMemoryCapacityPhase, number>>;
  };
  phase_p95_rss_bytes: Partial<Record<RunnerMemoryCapacityPhase, number>>;
  reviewed_by: string;
  sampling: { fresh: boolean; samples: number; status: "passed" | "failed" };
  soak: { drift_bytes: number; duration_ms: number; status: "passed" | "failed" };
  status: "passed" | "failed";
};

export type DatasetScale = {
  automations_per_project: number;
  automation_events_per_automation: number;
  automation_runs_per_automation: number;
  events_per_issue: number;
  issues_per_project: number;
  projects: number;
  runs_per_issue: number;
  sessions_per_issue: number;
};

export type LatencyResult = {
  budget: { p50: number; p95: number };
  max: number;
  p50: number;
  p95: number;
  samples: number;
  status: "passed" | "failed";
};

export type CapacityReport = {
  authority: Record<string, string>;
  budgets: typeof CAPACITY_BUDGETS;
  database: {
    allocated_bytes: number;
    alert_bytes: number;
    event_summary_projection_rows: number;
    issue_event_rows: number;
    projection_lag_rows: number;
    raw_and_projection_bytes: number;
    raw_and_projection_bytes_per_event: number;
    raw_and_projection_bytes_per_event_budget: number;
    status: "passed" | "failed";
  };
  generated_at: string;
  label: string;
  latency_ms: Record<string, LatencyResult>;
  memory: {
    budget_peak_rss_bytes: number;
    budget_rss_growth_bytes: number;
    peak_rss_bytes: number;
    rss_growth_bytes: number;
    start_rss_bytes: number;
    status: "passed" | "failed";
  };
  query_plans: Record<string, string[]>;
  regressions: Array<{ baseline_p95: number; candidate_p95: number; name: string; ratio: number }>;
  scale: Record<string, number>;
  schema_version: typeof CAPACITY_REPORT_SCHEMA;
  status: "passed" | "failed";
};

export const DEFAULT_DATASET_SCALE: DatasetScale = {
  automations_per_project: 10,
  automation_events_per_automation: 20,
  automation_runs_per_automation: 5,
  events_per_issue: 100,
  issues_per_project: 100,
  projects: 4,
  runs_per_issue: 2,
  sessions_per_issue: 1
};

export async function snapshotDatabase(sourcePath: string, outputPath: string): Promise<{ bytes: number; output: string }> {
  await assertAbsent(outputPath);
  const source = new SQLiteDatabase(sourcePath, { readonly: true, strict: true });
  try {
    const snapshot = source.serialize();
    await writeFile(outputPath, snapshot, { flag: "wx" });
    return { bytes: snapshot.byteLength, output: basename(outputPath) };
  } finally {
    source.close();
  }
}

export async function generateCapacityDataset(
  outputPath: string,
  input: Partial<DatasetScale> = {}
): Promise<{ allocated_bytes: number; output: string; scale: DatasetScale }> {
  await assertAbsent(outputPath);
  const scale = normalizedScale(input);
  const db = await openDatabase({ dbPath: outputPath, stateDir: dirname(outputPath) });
  try {
    seedDataset(db, scale);
    projectPendingEventSummaries(db);
    db.sqlite.run("pragma optimize");
  } finally {
    db.close();
  }
  return { allocated_bytes: (await stat(outputPath)).size, output: basename(outputPath), scale };
}

export async function runCapacityBenchmark(input: {
  baseline?: CapacityReport;
  dbPath: string;
  label?: string;
  samples?: number;
  warmups?: number;
}): Promise<CapacityReport> {
  const samples = boundedInteger(input.samples ?? 20, "samples", 5, 100);
  const warmups = boundedInteger(input.warmups ?? 2, "warmups", 0, 20);
  if (input.baseline && input.baseline.schema_version !== CAPACITY_REPORT_SCHEMA) {
    throw new Error(`baseline schema must be ${CAPACITY_REPORT_SCHEMA}`);
  }
  const db = await openDatabase({ dbPath: input.dbPath, stateDir: dirname(input.dbPath) });
  const startRSS = process.memoryUsage().rss;
  let peakRSS = startRSS;
  try {
    projectPendingEventSummaries(db);
    const scale = databaseScale(db);
    const context = benchmarkContext(db);
    const workloads: Record<string, () => unknown> = {
      "projects.frontend_list": () => listProjects(db),
      "issues.frontend_page_100": () => listIssues(db, {
        limit: 100, offset: 0, projectId: context.largestProjectID
      }),
      "sessions.project_catalog": () => listAgentSessions(db, { projectId: context.largestProjectID }),
      "runs.frontend_page_100": () => listRuns(db, {
        limit: 100, offset: 0, project_id: context.largestProjectID
      }),
      "runs.active_projection_8": () => runProgressProjectionStatus(db),
      "automations.frontend_list_500": () => listAutomations(db).map((automation) => ({
        automation,
        latest_run: listAutomationRuns(db, automation.id)[0] ?? null,
        trigger: getAutomationTrigger(db, automation.id)
      })),
      "timeline.long_session_first_60": () => queryWorkTimeline(
        db,
        issueIDToWorkID(context.longestIssueID),
        { limit: 60 }
      )
    };
    const latency: Record<string, LatencyResult> = {};
    for (const [name, run] of Object.entries(workloads)) {
      const values = measure(run, samples, warmups);
      peakRSS = Math.max(peakRSS, process.memoryUsage().rss);
      const budget = CAPACITY_BUDGETS.latency_ms[name as keyof typeof CAPACITY_BUDGETS.latency_ms];
      latency[name] = {
        budget,
        max: rounded(values.at(-1) ?? 0),
        p50: rounded(percentile(values, 0.5)),
        p95: rounded(percentile(values, 0.95)),
        samples,
        status: percentile(values, 0.5) <= budget.p50 && percentile(values, 0.95) <= budget.p95
          ? "passed" : "failed"
      };
    }
    const database = databaseFootprint(db, (await stat(input.dbPath)).size);
    const memory = {
      budget_peak_rss_bytes: CAPACITY_BUDGETS.memory.peak_rss_bytes,
      budget_rss_growth_bytes: CAPACITY_BUDGETS.memory.rss_growth_bytes,
      peak_rss_bytes: peakRSS,
      rss_growth_bytes: Math.max(0, peakRSS - startRSS),
      start_rss_bytes: startRSS,
      status: peakRSS <= CAPACITY_BUDGETS.memory.peak_rss_bytes &&
        peakRSS - startRSS <= CAPACITY_BUDGETS.memory.rss_growth_bytes ? "passed" as const : "failed" as const
    };
    const regressions = input.baseline ? capacityLatencyRegressions(input.baseline, latency) : [];
    const status = Object.values(latency).every((item) => item.status === "passed") &&
      database.status === "passed" && memory.status === "passed" && regressions.length === 0
      ? "passed" : "failed";
    return {
      authority: {
        automations: "automation_definitions+automation_runs+automation_events",
        compatibility: "benchmark-only reads; no dual-read, dual-write, schema, or runtime state machine",
        events: "issue_events; event_summary_projection is rebuildable derived data",
        issues: "issues",
        rollback: "delete the generated copy and reports; live runtime data is never modified",
        runs: "issue_runs+run_attempts+issue_events",
        sessions: "agent_sessions catalog; provider transcript remains provider-authoritative",
        timeline: "existing Work timeline projection over Issue/Run/PI authorities"
      },
      budgets: CAPACITY_BUDGETS,
      database,
      generated_at: new Date().toISOString(),
      label: cleanLabel(input.label || basename(input.dbPath)),
      latency_ms: latency,
      memory,
      query_plans: queryPlans(db, context),
      regressions,
      scale,
      schema_version: CAPACITY_REPORT_SCHEMA,
      status
    };
  } finally {
    db.close();
  }
}

export function capacityReportMarkdown(report: CapacityReport): string {
  const lines = [
    `# Xuanwu capacity benchmark: ${report.label}`,
    "",
    `- Status: **${report.status}**`,
    `- Generated: ${report.generated_at}`,
    `- Dataset: ${Object.entries(report.scale).map(([key, value]) => `${key}=${value}`).join(", ")}`,
    "",
    "## Latency budgets",
    "",
    "| Workload | P50 | P95 | Budget P50 / P95 | Status |",
    "| --- | ---: | ---: | ---: | --- |",
    ...Object.entries(report.latency_ms).map(([name, item]) =>
      `| ${name} | ${item.p50.toFixed(2)} ms | ${item.p95.toFixed(2)} ms | ${item.budget.p50} / ${item.budget.p95} ms | ${item.status} |`
    ),
    "",
    "## Growth and memory",
    "",
    `- DB allocated: ${mib(report.database.allocated_bytes)} MiB (alert at ${mib(report.database.alert_bytes)} MiB).`,
    `- Raw + projection: ${report.database.raw_and_projection_bytes_per_event.toFixed(1)} bytes/event (budget ${report.database.raw_and_projection_bytes_per_event_budget} bytes/event).`,
    `- Projection lag: ${report.database.projection_lag_rows} rows.`,
    `- Peak RSS: ${mib(report.memory.peak_rss_bytes)} MiB; growth ${mib(report.memory.rss_growth_bytes)} MiB.`,
    "",
    "## Authority and rollback",
    "",
    ...Object.entries(report.authority).map(([key, value]) => `- **${key}:** ${value}`),
    "",
    "## Regression result",
    "",
    report.regressions.length === 0
      ? "No P95 regression exceeded both +25% and +5 ms."
      : report.regressions.map((item) => `- ${item.name}: ${item.baseline_p95} -> ${item.candidate_p95} ms (${item.ratio}x)`).join("\n"),
    ""
  ];
  return lines.join("\n");
}

export function evaluateRunnerMemoryCapacity(input: {
  baselineEvidenceId: string;
  reviewedBy: string;
  samples: RunnerMemoryCapacitySample[];
}): RunnerMemoryCapacityReport {
  const samples = [...input.samples].sort((left, right) => Date.parse(left.observed_at) - Date.parse(right.observed_at));
  const missingPhases = RUNNER_MEMORY_CAPACITY_PHASES.filter((phase) => !samples.some((sample) => sample.phase === phase));
  const phaseP95 = Object.fromEntries(RUNNER_MEMORY_CAPACITY_PHASES.flatMap((phase) => {
    const values = samples.filter((sample) => sample.phase === phase).map((sample) => sample.group_rss_bytes);
    return values.length === 0 ? [] : [[phase, samplePercentile(values, 0.95)]];
  })) as Partial<Record<RunnerMemoryCapacityPhase, number>>;
  const phaseFootprintP95 = Object.fromEntries(RUNNER_MEMORY_CAPACITY_PHASES.flatMap((phase) => {
    const values = samples.filter((sample) => sample.phase === phase && Number.isFinite(sample.footprint_bytes))
      .map((sample) => Number(sample.footprint_bytes));
    return values.length === 0 ? [] : [[phase, samplePercentile(values, 0.95)]];
  })) as Partial<Record<RunnerMemoryCapacityPhase, number>>;
  const phaseMainP95 = {
    array_buffers: optionalPhaseP95(samples, "main_array_buffers_bytes"),
    external: optionalPhaseP95(samples, "main_external_bytes"),
    heap_used: optionalPhaseP95(samples, "main_heap_used_bytes")
  };
  const lifecycleEnds = lifecycleCycleEnds(samples);
  const lifecycleMonotonicGrowth = lifecycleEnds.length >= 2 &&
    lifecycleEnds.at(-1)! > lifecycleEnds[0]! &&
    lifecycleEnds.every((value, index) => index === 0 || value >= (lifecycleEnds[index - 1] ?? value));
  const soakSamples = samples.filter((sample) => sample.phase === "soak");
  const soakDuration = durationMs(soakSamples);
  const soakDrift = driftBytes(soakSamples);
  const idleSamples = samples.filter((sample) => sample.phase === "idle");
  const postTTL = samples.filter((sample) => sample.phase === "post_ttl");
  const activeSamples = samples.filter((sample) => ["run", "cancel", "failure_retry"].includes(sample.phase));
  const inactiveSamples = samples.filter((sample) => !["run", "cancel", "failure_retry"].includes(sample.phase));
  const idleBaseline = samplePercentile(idleSamples.map((sample) => sample.group_rss_bytes), 0.5);
  const mainIdleP95 = samplePercentile(inactiveSamples.map((sample) => Math.max(sample.main_process_rss_bytes, sample.main_ps_rss_bytes)), 0.95);
  const inactiveGroupP95 = samplePercentile(inactiveSamples.map((sample) => sample.group_rss_bytes), 0.95);
  const activeGroupP95 = samplePercentile(activeSamples.map((sample) => sample.group_rss_bytes), 0.95);
  const lifecycleStatus = lifecycleEnds.length === 20 && !lifecycleMonotonicGrowth ? "passed" : "failed";
  const soakStatus = soakDuration >= 30 * 60_000 && soakDrift <= PROCESS_GROUP_MEMORY_BUDGETS.soak_drift_bytes.hard
    ? "passed" : "failed";
  const phaseBudgetsPassed = inactiveGroupP95 <= PROCESS_GROUP_MEMORY_BUDGETS.idle_group_rss_p95_bytes.hard &&
    activeGroupP95 <= PROCESS_GROUP_MEMORY_BUDGETS.active_run_group_rss_p95_bytes.hard &&
    mainIdleP95 <= PROCESS_GROUP_MEMORY_BUDGETS.idle_main_rss_bytes.hard &&
    postTTL.length > 0 && postTTL.every((sample) => sample.group_rss_bytes <= idleBaseline + PROCESS_GROUP_MEMORY_BUDGETS.post_run_delta_bytes.hard);
  const reviewed = input.baselineEvidenceId.trim().startsWith("xw:evidence:") && input.reviewedBy.trim() !== "";
  const samplingFresh = samples.length > 0 && samples.every((sample) => sample.freshness_status === "fresh" && sample.sample_age_ms <= 5_000);
  return {
    baseline_evidence_id: input.baselineEvidenceId.trim(),
    budgets: PROCESS_GROUP_MEMORY_BUDGETS,
    group_p95_rss_bytes: { active_run: activeGroupP95, inactive: inactiveGroupP95, main_idle: mainIdleP95 },
    lifecycle: { cycles: lifecycleEnds.length, monotonic_growth: lifecycleMonotonicGrowth, status: lifecycleStatus },
    metric_definitions: PROCESS_GROUP_MEMORY_METRIC_DEFINITIONS,
    missing_phases: missingPhases,
    phase_p95_footprint_bytes: phaseFootprintP95,
    phase_p95_main_memory_bytes: phaseMainP95,
    phase_p95_rss_bytes: phaseP95,
    reviewed_by: input.reviewedBy.trim(),
    sampling: { fresh: samplingFresh, samples: samples.length, status: samplingFresh ? "passed" : "failed" },
    soak: { drift_bytes: soakDrift, duration_ms: soakDuration, status: soakStatus },
    status: missingPhases.length === 0 && lifecycleStatus === "passed" && soakStatus === "passed" && phaseBudgetsPassed && reviewed && samplingFresh
      ? "passed" : "failed"
  };
}

function lifecycleCycleEnds(samples: RunnerMemoryCapacitySample[]): number[] {
  const cycles = new Map<number, RunnerMemoryCapacitySample>();
  for (const sample of samples) {
    if (sample.phase !== "lifecycle" || !Number.isInteger(sample.cycle) || (sample.cycle ?? 0) < 1) continue;
    cycles.set(sample.cycle!, sample);
  }
  return [...cycles].sort(([left], [right]) => left - right).map(([, sample]) => sample.group_rss_bytes);
}

function durationMs(samples: RunnerMemoryCapacitySample[]): number {
  if (samples.length < 2) return 0;
  return Math.max(0, Date.parse(samples.at(-1)!.observed_at) - Date.parse(samples[0]!.observed_at));
}

function driftBytes(samples: RunnerMemoryCapacitySample[]): number {
  if (samples.length < 2) return 0;
  return Math.max(0, samples.at(-1)!.group_rss_bytes - samples[0]!.group_rss_bytes);
}

function samplePercentile(values: number[], quantile: number): number {
  return percentile([...values].sort((left, right) => left - right), quantile);
}

function optionalPhaseP95(
  samples: RunnerMemoryCapacitySample[],
  key: "main_array_buffers_bytes" | "main_external_bytes" | "main_heap_used_bytes"
): Partial<Record<RunnerMemoryCapacityPhase, number>> {
  return Object.fromEntries(RUNNER_MEMORY_CAPACITY_PHASES.flatMap((phase) => {
    const values = samples.filter((sample) => sample.phase === phase && Number.isFinite(sample[key]))
      .map((sample) => Number(sample[key]));
    return values.length === 0 ? [] : [[phase, samplePercentile(values, 0.95)]];
  })) as Partial<Record<RunnerMemoryCapacityPhase, number>>;
}

function seedDataset(db: RunnerDatabase, scale: DatasetScale): void {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const insert = db.transaction(() => {
    for (let projectIndex = 0; projectIndex < scale.projects; projectIndex += 1) {
      const projectID = `capacity-project-${String(projectIndex + 1).padStart(3, "0")}`;
      db.sqlite.run(`insert into projects (id, name, cwd, provider, sort_order, created_at, updated_at)
        values (?, ?, ?, 'codex', ?, ?, ?)`, [
        projectID, `Capacity project ${projectIndex + 1}`, `/tmp/${projectID}`, projectIndex + 1, timestamp, timestamp
      ]);
      const issueIDs: number[] = [];
      for (let issueIndex = 0; issueIndex < scale.issues_per_project; issueIndex += 1) {
        const issueAt = isoAt(projectIndex * scale.issues_per_project + issueIndex);
        db.sqlite.run(`insert into issues
          (project_id, title, description, status, priority, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?)`, [
          projectID,
          `Capacity issue ${issueIndex + 1}`,
          "Deterministic Xuanwu capacity fixture",
          issueIndex % 11 === 0 ? "in_progress" : "done",
          scale.issues_per_project - issueIndex,
          issueAt,
          issueAt
        ]);
        const issueID = Number(db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id);
        issueIDs.push(issueID);
        for (let runIndex = 0; runIndex < scale.runs_per_issue; runIndex += 1) {
          const active = projectIndex === 0 && issueIndex < 8 && runIndex === scale.runs_per_issue - 1;
          const startedAt = isoAt(projectIndex * 1_000_000 + issueIndex * 10_000 + runIndex * 1_000);
          db.sqlite.run(`insert into issue_runs
            (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id,
             started_at, ended_at, exit_reason)
            values (?, ?, ?, ?, 'codex', ?, ?, ?, ?, ?)`, [
            `capacity-${projectIndex}-${issueIndex}-${runIndex}`,
            issueID,
            runIndex + 1,
            active ? "in_progress" : "done",
            `capacity-session-${projectIndex}-${issueIndex}-${runIndex}`,
            `capacity-turn-${projectIndex}-${issueIndex}-${runIndex}`,
            startedAt,
            active ? "" : isoAt(projectIndex * 1_000_000 + issueIndex * 10_000 + runIndex * 1_000 + 900),
            active ? "" : "completed"
          ]);
        }
        for (let sessionIndex = 0; sessionIndex < scale.sessions_per_issue; sessionIndex += 1) {
          const sessionID = `catalog-${projectIndex}-${issueIndex}-${sessionIndex}`;
          db.sqlite.run(`insert into agent_sessions
            (session_key, provider, provider_session_id, agent_role, project_id, issue_id,
             title, preview, status, raw_ref, created_at, updated_at)
            values (?, 'codex', ?, 'executor', ?, ?, ?, ?, 'idle', '{}', ?, ?)`, [
            `codex:${sessionID}`, sessionID, projectID, issueID,
            `Capacity session ${issueIndex + 1}`, "Capacity session catalog row", issueAt, issueAt
          ]);
        }
        for (let eventIndex = 0; eventIndex < scale.events_per_issue; eventIndex += 1) {
          const body = JSON.stringify({
            raw_method: "item/agentMessage/delta",
            text: `capacity-event-${eventIndex}-${"x".repeat(128)}`,
            type: "agent_message_delta"
          });
          db.sqlite.run("insert into issue_events (issue_id, type, payload, created_at) values (?, 'issue.log', ?, ?)", [
            issueID, body, isoAt(projectIndex * 1_000_000 + issueIndex * 10_000 + eventIndex)
          ]);
        }
      }
      seedAutomations(db, projectID, projectIndex, scale, timestamp);
    }
  });
  insert.immediate();
}

function seedAutomations(
  db: RunnerDatabase,
  projectID: string,
  projectIndex: number,
  scale: DatasetScale,
  timestamp: string
): void {
  for (let index = 0; index < scale.automations_per_project; index += 1) {
    const id = `capacity-automation-${projectIndex}-${index}`;
    db.sqlite.run(`insert into automation_definitions
      (id, scope_kind, scope_id, name, workflow_ref, permission_policy_ref, mode,
       status, idempotency_namespace, active_trigger_version, revision, created_at, updated_at)
      values (?, 'project', ?, ?, 'xuanwu://capacity', 'policy://capacity', 'observe',
        'active', ?, 1, 0, ?, ?)`, [id, projectID, `Capacity automation ${index + 1}`, id, timestamp, timestamp]);
    db.sqlite.run(`insert into automation_trigger_configs
      (automation_id, version, trigger_type, config_json, created_by, created_at)
      values (?, 1, 'manual', '{}', 'capacity-generator', ?)`, [id, timestamp]);
    for (let runIndex = 0; runIndex < scale.automation_runs_per_automation; runIndex += 1) {
      db.sqlite.run(`insert into automation_runs
        (run_id, automation_id, trigger_version, idempotency_key, status, requested_at,
         completed_at, summary_json, created_at)
        values (?, ?, 1, ?, 'succeeded', ?, ?, '{}', ?)`, [
        `${id}-run-${runIndex}`, id, `${idempotency(id, runIndex)}`, timestamp, timestamp, timestamp
      ]);
    }
    for (let eventIndex = 0; eventIndex < scale.automation_events_per_automation; eventIndex += 1) {
      db.sqlite.run(`insert into automation_events
        (event_id, automation_id, event_type, expected_revision, before_revision,
         after_revision, actor_id, actor_kind, correlation_id, gate_authority,
         gate_decision, gate_policy_ref, reason, payload_json, occurred_at)
        values (?, ?, 'capacity.observed', 0, 0, 0, 'capacity-generator', 'system', ?,
          'deterministic_policy', 'allow', 'policy://capacity', 'capacity fixture', '{}', ?)`, [
        `${id}-event-${eventIndex}`, id, `${id}-correlation-${eventIndex}`, isoAt(eventIndex)
      ]);
    }
  }
}

function benchmarkContext(db: RunnerDatabase): { largestProjectID: string; longestIssueID: number } {
  const largestProjectID = db.sqlite.query<{ project_id: string }, []>(`
    select project_id from issues group by project_id order by count(*) desc, project_id asc limit 1
  `).get()?.project_id;
  const longestIssueID = db.sqlite.query<{ issue_id: number }, []>(`
    select issue_id from issue_events group by issue_id order by count(*) desc, issue_id asc limit 1
  `).get()?.issue_id;
  if (!largestProjectID || !longestIssueID) throw new Error("benchmark database must contain projects, issues, and issue_events");
  return { largestProjectID, longestIssueID };
}

function databaseScale(db: RunnerDatabase): Record<string, number> {
  return {
    active_runs: scalar(db, "select count(*) as value from issue_runs where status='in_progress'"),
    agent_sessions: count(db, "agent_sessions"),
    automation_definitions: count(db, "automation_definitions"),
    automation_events: count(db, "automation_events"),
    automation_runs: count(db, "automation_runs"),
    event_summary_projection: count(db, "event_summary_projection"),
    issue_events: count(db, "issue_events"),
    issue_runs: count(db, "issue_runs"),
    issues: count(db, "issues"),
    max_events_per_issue: scalar(db, "select coalesce(max(value), 0) as value from (select count(*) value from issue_events group by issue_id)"),
    max_issues_per_project: scalar(db, "select coalesce(max(value), 0) as value from (select count(*) value from issues group by project_id)"),
    projects: count(db, "projects"),
    run_attempts: count(db, "run_attempts")
  };
}

function databaseFootprint(db: RunnerDatabase, allocatedBytes: number): CapacityReport["database"] {
  const events = count(db, "issue_events");
  const projection = count(db, "event_summary_projection");
  const rawAndProjection = db.sqlite.query<{ bytes: number }, []>(`
    select coalesce(sum(pgsize), 0) as bytes from dbstat
    where name in (
      'issue_events', 'idx_issue_events_issue_type',
      'event_summary_projection', 'sqlite_autoindex_event_summary_projection_1',
      'idx_event_summary_projection_issue', 'idx_event_summary_projection_project'
    )
  `).get()?.bytes ?? 0;
  const lag = scalar(db, `select count(*) as value from issue_events e
    where not exists (select 1 from event_summary_projection p
      where p.source='issue_events' and p.source_event_id=e.id)`);
  const perEvent = events === 0 ? 0 : rawAndProjection / events;
  const passed = allocatedBytes <= CAPACITY_BUDGETS.database.alert_bytes &&
    perEvent <= CAPACITY_BUDGETS.database.raw_and_projection_bytes_per_event && lag === 0;
  return {
    allocated_bytes: allocatedBytes,
    alert_bytes: CAPACITY_BUDGETS.database.alert_bytes,
    event_summary_projection_rows: projection,
    issue_event_rows: events,
    projection_lag_rows: lag,
    raw_and_projection_bytes: rawAndProjection,
    raw_and_projection_bytes_per_event: rounded(perEvent),
    raw_and_projection_bytes_per_event_budget: CAPACITY_BUDGETS.database.raw_and_projection_bytes_per_event,
    status: passed ? "passed" : "failed"
  };
}

function queryPlans(
  db: RunnerDatabase,
  context: { largestProjectID: string; longestIssueID: number }
): Record<string, string[]> {
  return {
    issue_frontend_page: explain(db, `select id from issues where project_id=?
      order by priority desc, created_at asc limit 100`, context.largestProjectID),
    run_frontend_page: explain(db, `select run.id from issue_runs run join issues issue on issue.id=run.issue_id
      where issue.project_id=? order by run.started_at desc limit 100`, context.largestProjectID),
    timeline_summary_page: explain(db, `select source_event_id from event_summary_projection
      where source='issue_events' and issue_id=? order by source_event_id desc limit 61`, context.longestIssueID)
  };
}

export function capacityLatencyRegressions(
  baseline: CapacityReport,
  candidate: Record<string, LatencyResult>
): CapacityReport["regressions"] {
  return Object.entries(candidate).flatMap(([name, item]) => {
    const previous = baseline.latency_ms[name]?.p95;
    if (!previous || item.p95 - previous < CAPACITY_BUDGETS.regression.minimum_delta_ms ||
        item.p95 / previous <= CAPACITY_BUDGETS.regression.p95_ratio) return [];
    return [{ baseline_p95: previous, candidate_p95: item.p95, name, ratio: rounded(item.p95 / previous) }];
  });
}

function measure(run: () => unknown, samples: number, warmups: number): number[] {
  for (let index = 0; index < warmups; index += 1) run();
  const values: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    run();
    values.push(performance.now() - started);
  }
  return values.sort((left, right) => left - right);
}

function percentile(sorted: number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[Math.min(index, sorted.length - 1)]!;
}

function explain(db: RunnerDatabase, sql: string, ...args: Array<number | string>): string[] {
  return db.sqlite.query<{ detail: string }, Array<number | string>>(`explain query plan ${sql}`)
    .all(...args).map((row) => row.detail);
}

function count(db: RunnerDatabase, table: string): number {
  return scalar(db, `select count(*) as value from ${table}`);
}

function scalar(db: RunnerDatabase, sql: string): number {
  return db.sqlite.query<{ value: number }, []>(sql).get()?.value ?? 0;
}

function normalizedScale(input: Partial<DatasetScale>): DatasetScale {
  const scale = {
    automations_per_project: boundedInteger(input.automations_per_project ?? DEFAULT_DATASET_SCALE.automations_per_project, "automations_per_project", 0, 10_000),
    automation_events_per_automation: boundedInteger(input.automation_events_per_automation ?? DEFAULT_DATASET_SCALE.automation_events_per_automation, "automation_events_per_automation", 0, 100_000),
    automation_runs_per_automation: boundedInteger(input.automation_runs_per_automation ?? DEFAULT_DATASET_SCALE.automation_runs_per_automation, "automation_runs_per_automation", 0, 100_000),
    events_per_issue: boundedInteger(input.events_per_issue ?? DEFAULT_DATASET_SCALE.events_per_issue, "events_per_issue", 1, 1_000_000),
    issues_per_project: boundedInteger(input.issues_per_project ?? DEFAULT_DATASET_SCALE.issues_per_project, "issues_per_project", 1, 1_000_000),
    projects: boundedInteger(input.projects ?? DEFAULT_DATASET_SCALE.projects, "projects", 1, 10_000),
    runs_per_issue: boundedInteger(input.runs_per_issue ?? DEFAULT_DATASET_SCALE.runs_per_issue, "runs_per_issue", 1, 1_000),
    sessions_per_issue: boundedInteger(input.sessions_per_issue ?? DEFAULT_DATASET_SCALE.sessions_per_issue, "sessions_per_issue", 0, 1_000)
  };
  assertGeneratedRows("issues", scale.projects * scale.issues_per_project, 1_000_000);
  assertGeneratedRows("issue events", scale.projects * scale.issues_per_project * scale.events_per_issue, 10_000_000);
  assertGeneratedRows("issue runs", scale.projects * scale.issues_per_project * scale.runs_per_issue, 5_000_000);
  assertGeneratedRows("agent sessions", scale.projects * scale.issues_per_project * scale.sessions_per_issue, 5_000_000);
  assertGeneratedRows("automations", scale.projects * scale.automations_per_project, 100_000);
  assertGeneratedRows("automation events", scale.projects * scale.automations_per_project * scale.automation_events_per_automation, 5_000_000);
  assertGeneratedRows("automation runs", scale.projects * scale.automations_per_project * scale.automation_runs_per_automation, 5_000_000);
  return scale;
}

function assertGeneratedRows(label: string, rows: number, maximum: number): void {
  if (!Number.isSafeInteger(rows) || rows > maximum) {
    throw new Error(`${label} dataset would create ${rows} rows; maximum is ${maximum}`);
  }
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await stat(path);
    throw new Error(`refusing to overwrite existing database: ${path}`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function cleanLabel(value: string): string {
  return value.trim().replaceAll(/[/\\]/g, "-").slice(0, 120) || "capacity-benchmark";
}

function isoAt(offsetSeconds: number): string {
  return new Date(Date.UTC(2026, 0, 1) + offsetSeconds * 1_000).toISOString();
}

function idempotency(id: string, index: number): string {
  return `${id}:run:${index}`;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function mib(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
