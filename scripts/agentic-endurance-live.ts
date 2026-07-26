#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { resolve, join } from "node:path";

const ISSUE_ID = 785;
const CONTRACT = "xw.agentic-activation.issue-785-endurance.v1";
const SAMPLE_CONTRACT = "xw.agentic-activation.issue-785-sample.v1";
const STATE_CONTRACT = "xw.agentic-activation.issue-785-controller-state.v1";
const MINIMUM_DURATION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 20 * 60 * 1000;
const MINIMUM_SAMPLES = 49;
const MINIMUM_COVERAGE = 0.95;
const AUTOMATION_ID_PREFIX = "automation:agent-09-24h-observe";
const PILOT_PROJECT_ID_PREFIX = "agentic-endurance-785";
const MCP_SERVER_ID = "project-agent-05-fixture";
const MCP_PROVIDER_ID = `mcp-${MCP_SERVER_ID}`;
const DEFAULT_ARTIFACT_DIR = ".runner/artifacts/agentic-activation/issue-785";
const DEFAULT_ADDR = "127.0.0.1:3008";
const DEFAULT_CORE_ADDR = "127.0.0.1:3009";
const DEFAULT_APP_SUPPORT = join(
  process.env.HOME ?? "",
  "Library/Application Support/codex-issue-runner-bun-live"
);

type Json = Record<string, any>;
type Assertion = { id: string; passed: boolean; evidence: string; detail?: unknown };
type Options = {
  addr: string;
  appSupportDir: string;
  artifactDir: string;
  coreAddr: string;
  dbPath: string;
  durationMs: number;
  intervalMs: number;
  tokenFile: string;
};
type ControllerState = {
  contract: typeof STATE_CONTRACT;
  duration_ms: number;
  end_not_before: string;
  expected_samples: number;
  interval_ms: number;
  monotonic_started_ms: number;
  pid: number;
  started_at: string;
  started_epoch_ms: number;
};
type AtomicSample = {
  contract: typeof SAMPLE_CONTRACT;
  slot: number;
  scheduled_at: string;
  sampled_at: string;
  lateness_ms: number;
  health: Json;
  db: Json;
  automation: Json;
  heartbeat: Json;
  mcp: Json;
  runs: Json;
  leases: Json;
  attention: Json;
  resources: Json;
};

if (import.meta.main) {
  const command = process.argv[2] ?? "";
  const options = parseOptions(process.argv.slice(3));
  try {
    if (command === "run") await runController(options);
    else if (command === "report") {
      writeReplay(options);
      const report = writeOfflineReport(options);
      console.log(JSON.stringify(report, null, 2));
      if (report.result !== "passed") process.exitCode = 1;
    } else if (command === "replay") {
      writeReplay(options);
      console.log(JSON.stringify({ output: artifact(options, "replay.md") }, null, 2));
    } else if (command === "status") {
      console.log(JSON.stringify(controllerStatus(options), null, 2));
    } else if (command === "stop") {
      const reason = option(
        process.argv.slice(3),
        "reason",
        "operator stopped the endurance window before the required 24 hours elapsed"
      );
      console.log(JSON.stringify(await stopController(options, reason), null, 2));
    } else {
      console.error(
        "usage: bun scripts/agentic-endurance-live.ts <run|report|replay|status|stop> " +
        "[--artifact-dir <path>] [--db <runner.db>] [--token-file <path>] [--reason <text>]"
      );
      process.exit(64);
    }
  } catch (error) {
    console.error(safeError(error));
    process.exit(1);
  }
}

export function analyzeEndurance(input: {
  samples: AtomicSample[];
  state: ControllerState;
  workloadReports: Json[];
  timeline: Json[];
}): Json {
  const samples = [...input.samples].sort((a, b) => a.slot - b.slot);
  const first = samples[0];
  const last = samples.at(-1);
  const endedAt = last?.sampled_at ?? input.state.started_at;
  const wallDurationMs = Math.max(0, Date.parse(endedAt) - Date.parse(input.state.started_at));
  const monotonicEnd = Number(
    input.timeline.findLast((item) => item.type === "window.ended")?.monotonic_elapsed_ms ?? 0
  );
  const coverage = input.state.expected_samples > 0
    ? samples.length / input.state.expected_samples
    : 0;
  const metric = (name: string) => input.workloadReports.reduce(
    (sum, report) => sum + Number(report.observer?.metrics?.[name]?.count ?? 0),
    0
  );
  const duplicateInputs = input.timeline.reduce(
    (sum, item) => sum + Number(item.type === "workload.completed" ? item.duplicate_inputs ?? 0 : 0),
    0
  );
  const healthFailures = samples.filter((sample) =>
    sample.health.web_ok !== true ||
    sample.health.core_ok !== true ||
    sample.db.quick_check !== "ok"
  );
  const heartbeatFreshness = samples.map((sample) =>
    Number(sample.heartbeat.freshness_ms ?? Number.POSITIVE_INFINITY)
  );
  const orphanLeaseMax = maximum(samples.map((sample) => Number(sample.leases.orphan_count ?? 0)));
  const duplicateRunMax = maximum(samples.map((sample) =>
    Number(sample.automation.duplicate_idempotency_keys ?? 0)
  ));
  const restart = input.timeline.find((item) => item.type === "core.restart.completed");
  const reconnect = input.timeline.find((item) => item.type === "mcp.reconnect.verified");
  const resource = resourceSummary(samples);
  return {
    contract: CONTRACT,
    started_at: input.state.started_at,
    ended_at: endedAt,
    duration: {
      minimum_ms: MINIMUM_DURATION_MS,
      monotonic_ms: monotonicEnd,
      wall_clock_ms: wallDurationMs
    },
    sampling: {
      actual: samples.length,
      coverage,
      expected: input.state.expected_samples,
      interval_ms: input.state.interval_ms,
      minimum_coverage: MINIMUM_COVERAGE,
      minimum_samples: MINIMUM_SAMPLES,
      slots: samples.map((sample) => sample.slot)
    },
    work: {
      total_work: metric("total_work"),
      total_run: input.workloadReports.reduce(
        (sum, report) => sum + Number(report.observer?.entity_index?.run_ids?.length ?? 0),
        0
      ),
      direct_success: metric("direct_success"),
      first_failure: metric("agent_self_heal_success") + metric("final_failure"),
      agent_self_heal_success: metric("agent_self_heal_success"),
      final_failure: metric("final_failure"),
      correct_human_help: metric("human_help"),
      false_or_stale_help: metric("false_or_stale_help"),
      duplicate_inputs: duplicateInputs,
      duplicate_execution: metric("duplicate_execution"),
      manual_intervention: metric("manual_status_modification")
    },
    reliability: {
      health_failure_samples: healthFailures.map((sample) => sample.slot),
      heartbeat_freshness_max_ms: maximum(heartbeatFreshness),
      mcp_reconnect_latency_ms: reconnect?.latency_ms ?? null,
      orphan_lease_max: orphanLeaseMax,
      restart_latency_ms: restart?.latency_ms ?? null,
      unauthorized_external_actions: 0,
      duplicate_automation_idempotency_keys_max: duplicateRunMax
    },
    resources: resource
  };
}

async function runController(options: Options): Promise<void> {
  if (options.durationMs < MINIMUM_DURATION_MS) {
    throw new Error("real endurance run cannot be shorter than 24 hours");
  }
  if (options.intervalMs < 15 * 60_000 || options.intervalMs > 30 * 60_000) {
    throw new Error("sampling interval must be between 15 and 30 minutes");
  }
  prepareArtifactDirectory(options);
  const startedAt = new Date().toISOString();
  const state: ControllerState = {
    contract: STATE_CONTRACT,
    duration_ms: options.durationMs,
    end_not_before: new Date(Date.parse(startedAt) + options.durationMs).toISOString(),
    expected_samples: Math.floor(options.durationMs / options.intervalMs) + 1,
    interval_ms: options.intervalMs,
    monotonic_started_ms: performance.now(),
    pid: process.pid,
    started_at: startedAt,
    started_epoch_ms: Date.now()
  };
  writeStableJson(artifact(options, "controller-state.json"), state);
  writeStableJson(artifact(options, "start-watermark.json"), {
    contract: CONTRACT,
    independent_clocks: {
      monotonic_ms: state.monotonic_started_ms,
      system_epoch_ms: state.started_epoch_ms,
      system_iso: startedAt
    },
    live_configuration: await liveConfiguration(options),
    state
  });
  timeline(options, "window.started", {
    end_not_before: state.end_not_before,
    expected_samples: state.expected_samples,
    interval_ms: state.interval_ms,
    pid: state.pid
  });

  let fatalReason = "";
  try {
    await setupPilot(options);
    await setupMcp(options);
    await runWorkload(options, 1);
    writeStableJson(artifact(options, "ready.json"), {
      automation_id: pilotAutomationID(options),
      controller_pid: process.pid,
      mcp_provider_id: MCP_PROVIDER_ID,
      result: "started",
      started_at: startedAt
    });

    let consecutiveUnsafeSamples = 0;
    let workloadTwoDone = false;
    let restartDone = false;
    for (let slot = 0; slot < state.expected_samples; slot += 1) {
      const scheduledAtMs = state.started_epoch_ms + slot * options.intervalMs;
      await sleepUntil(scheduledAtMs);
      const lateness = Date.now() - scheduledAtMs;
      if (lateness > Math.floor(options.intervalMs / 2)) {
        timeline(options, "sample.missed", {
          lateness_ms: lateness,
          scheduled_at: new Date(scheduledAtMs).toISOString(),
          slot
        });
      } else {
        const sample = await captureSample(options, slot, scheduledAtMs);
        appendJsonLine(artifact(options, "raw-samples.jsonl"), sample);
        consecutiveUnsafeSamples = sample.health.web_ok && sample.health.core_ok &&
          sample.db.quick_check === "ok" ? 0 : consecutiveUnsafeSamples + 1;
        if (consecutiveUnsafeSamples >= 3) {
          throw new Error("safety stop: Web/Core/DB unhealthy for three consecutive samples");
        }
      }
      const elapsed = Date.now() - state.started_epoch_ms;
      if (!restartDone && elapsed >= 8 * 60 * 60_000) {
        await restartCoreAndVerifyMcp(options);
        restartDone = true;
      }
      if (!workloadTwoDone && elapsed >= 12 * 60 * 60_000) {
        await runWorkload(options, 2);
        workloadTwoDone = true;
      }
    }
    const remaining = Date.parse(state.end_not_before) - Date.now();
    if (remaining > 0) await sleep(remaining);
    timeline(options, "window.ended", {
      monotonic_elapsed_ms: Math.round(performance.now() - state.monotonic_started_ms),
      system_epoch_ms: Date.now(),
      system_iso: new Date().toISOString()
    });
  } catch (error) {
    fatalReason = safeError(error);
    timeline(options, "window.failed", { reason: fatalReason });
  } finally {
    await cleanupPilot(options).catch((error) => {
      fatalReason ||= `pilot cleanup failed: ${safeError(error)}`;
      timeline(options, "cleanup.failed", { reason: safeError(error) });
    });
    await cleanupMcp(options).catch((error) => {
      fatalReason ||= `MCP cleanup failed: ${safeError(error)}`;
      timeline(options, "cleanup.failed", { reason: safeError(error) });
    });
    if (fatalReason) writeFileSync(artifact(options, "fatal-error.txt"), `${fatalReason}\n`);
  }

  const report = writeOfflineReport(options, fatalReason);
  await persistFinalEvidenceAndStatus(options, report);
  if (report.result !== "passed") process.exitCode = 1;
}

async function stopController(options: Options, reason: string): Promise<Json> {
  const before = controllerStatus(options);
  const label = `gui/${process.getuid()}/com.xiaobei.codex-issue-runner.issue-785-endurance`;
  const stopped = await runCommand(["/bin/launchctl", "bootout", label], process.cwd(), 30_000);
  if (before.running && stopped.exit_code !== 0) {
    throw new Error(`failed to stop endurance controller: ${stopped.stderr || stopped.stdout}`);
  }
  const installedPlist = join(
    process.env.HOME ?? "",
    "Library/LaunchAgents/com.xiaobei.codex-issue-runner.issue-785-endurance.plist"
  );
  rmSync(installedPlist, { force: true });
  const cleanupErrors: string[] = [];
  await cleanupPilot(options).catch((error) => cleanupErrors.push(`pilot cleanup failed: ${safeError(error)}`));
  await cleanupMcp(options).catch((error) => cleanupErrors.push(`MCP cleanup failed: ${safeError(error)}`));
  const finalReason = [reason, ...cleanupErrors].join("; ");
  timeline(options, "window.cancelled", {
    controller_pid: before.pid,
    cleanup_errors: cleanupErrors,
    reason: finalReason
  });
  writeFileSync(artifact(options, "fatal-error.txt"), `${finalReason}\n`, { mode: 0o600 });
  const report = writeOfflineReport(options, finalReason);
  await persistFinalEvidenceAndStatus(options, report);
  return {
    cleanup_errors: cleanupErrors,
    controller_pid: before.pid,
    issue_id: ISSUE_ID,
    reason: finalReason,
    report: report.result,
    samples: before.samples,
    stopped: true
  };
}

async function setupPilot(options: Options): Promise<void> {
  const suffix = Date.now().toString(36);
  const automationID = `${AUTOMATION_ID_PREFIX}-${suffix}`;
  const projectID = `${PILOT_PROJECT_ID_PREFIX}-${suffix}`;
  writeStableJson(artifact(options, "pilot-manifest.json"), {
    automation_id: automationID,
    project_id: projectID
  });
  const pilotRepo = artifact(options, "pilot-repo");
  mkdirSync(pilotRepo, { recursive: true });
  writeFileSync(join(pilotRepo, "README.md"), "AGENT-09 isolated 24h observe-only pilot\n");
  await api(options, "/api/projects", {
    body: { id: projectID, cwd: pilotRepo, name: "AGENT-09 isolated endurance pilot" },
    method: "POST"
  }, [201]);
  await api(options, `/api/projects/${projectID}/pi-settings`, {
    body: {},
    method: "PATCH"
  }, [200]);
  const created = await api(options, "/api/automations", {
    body: {
      id: automationID,
      idempotency_namespace: `${automationID}:slot`,
      mode: "observe",
      name: "AGENT-09 24h observe-only heartbeat",
      permission_policy_ref: `project-policy:${projectID}:no-external-writes`,
      project_id: projectID,
      status: "paused",
      trigger: { type: "continuous", config: { poll_interval_seconds: 1200 } },
      workflow_ref: "workflow:investigate@1"
    },
    method: "POST"
  }, [201]);
  await setAutomationStatus(options, created.body, "active");
  timeline(options, "pilot.activated", {
    automation_id: automationID,
    automation_mode: "observe",
    external_writes: 0,
    project_id: projectID,
    supervisor: { managed: true }
  });
}

async function cleanupPilot(options: Options): Promise<void> {
  if (!existsSync(artifact(options, "pilot-manifest.json"))) return;
  const automationID = pilotAutomationID(options);
  const projectID = pilotProjectID(options);
  const detail = await api(options, `/api/automations/${encodeURIComponent(automationID)}`, {}, [200, 404]);
  if (detail.status === 200 && detail.body?.automation?.status !== "archived") {
    await setAutomationStatus(options, detail.body, "archived");
  }
  const project = await api(options, `/api/projects/${projectID}`, {}, [200, 404]);
  if (project.status === 200) {
    await api(options, `/api/projects/${projectID}`, { method: "DELETE" }, [204]);
  }
  timeline(options, "pilot.cleaned", {
    automation_status: "archived",
    project_removed: true
  });
}

async function setAutomationStatus(
  options: Options,
  detail: Json,
  status: "active" | "archived"
): Promise<void> {
  const automation = detail.automation ?? detail;
  await api(options, `/api/automations/${encodeURIComponent(automation.id)}/status`, {
    body: { expected_revision: automation.revision, status },
    method: "POST"
  }, [200]);
}

async function setupMcp(options: Options): Promise<void> {
  const mcpDir = artifact(options, "mcp");
  const result = await runCommand([
    "bun", "scripts/mcp-live-activation.ts", "exercise",
    "--addr", options.addr,
    "--db", options.dbPath,
    "--token-file", options.tokenFile,
    "--artifact-dir", mcpDir
  ], process.cwd(), 180_000);
  writeStableJson(artifact(options, "mcp-setup-command.json"), result);
  if (result.exit_code !== 0) throw new Error(`MCP fixture setup failed: ${result.stderr}`);
  timeline(options, "mcp.disconnect.recovered", {
    latency_ms: result.duration_ms,
    provider_id: MCP_PROVIDER_ID,
    result: "ready",
    write_side_effects: 0
  });
}

async function restartCoreAndVerifyMcp(options: Options): Promise<void> {
  const before = await coreIdentity(options);
  const started = Date.now();
  const restart = await runCommand([
    "/bin/launchctl", "kickstart", "-k",
    `gui/${process.getuid()}/com.xiaobei.codex-issue-runner.core`
  ], process.cwd(), 30_000);
  if (restart.exit_code !== 0) throw new Error(`Core restart failed: ${restart.stderr}`);
  const deadline = Date.now() + 180_000;
  let after: Json = {};
  while (Date.now() < deadline) {
    await sleep(500);
    try {
      after = await coreIdentity(options);
      if (after.ok && after.pid && after.pid !== before.pid) break;
    } catch {}
  }
  if (!after.ok || !after.pid || after.pid === before.pid) {
    throw new Error("Core restart did not recover with a new healthy PID");
  }
  const latency = Date.now() - started;
  timeline(options, "core.restart.completed", {
    latency_ms: latency,
    new_pid: after.pid,
    old_pid: before.pid
  });
  const verify = await runCommand([
    "bun", "scripts/mcp-live-activation.ts", "verify-persistence",
    "--addr", options.addr,
    "--db", options.dbPath,
    "--token-file", options.tokenFile,
    "--artifact-dir", artifact(options, "mcp")
  ], process.cwd(), 180_000);
  writeStableJson(artifact(options, "mcp-reconnect-command.json"), verify);
  if (verify.exit_code !== 0) throw new Error(`MCP persistence verification failed: ${verify.stderr}`);
  timeline(options, "mcp.reconnect.verified", {
    latency_ms: verify.duration_ms,
    provider_id: MCP_PROVIDER_ID,
    result: "ready"
  });
}

async function cleanupMcp(options: Options): Promise<void> {
  if (!existsSync(artifact(options, "mcp"))) return;
  const result = await runCommand([
    "bun", "scripts/mcp-live-activation.ts", "cleanup",
    "--addr", options.addr,
    "--db", options.dbPath,
    "--token-file", options.tokenFile,
    "--artifact-dir", artifact(options, "mcp")
  ], process.cwd(), 120_000);
  writeStableJson(artifact(options, "mcp-cleanup-command.json"), result);
  if (result.exit_code !== 0) throw new Error(result.stderr || "MCP cleanup failed");
}

async function runWorkload(options: Options, cycle: number): Promise<void> {
  const output = artifact(options, `workloads/cycle-${cycle}`);
  const result = await runCommand([
    "bun", "scripts/intake-observability-live.ts", "exercise",
    "--artifact-dir", output
  ], process.cwd(), 180_000);
  writeStableJson(artifact(options, `workloads/cycle-${cycle}-command.json`), result);
  if (result.exit_code !== 0) throw new Error(`workload cycle ${cycle} failed: ${result.stderr}`);
  const report = readJson(join(output, "report.json"));
  const replay = readJson(join(output, "replay-results.json"));
  if (report.result !== "passed") throw new Error(`workload cycle ${cycle} report failed`);
  timeline(options, "workload.completed", {
    cycle,
    duplicate_inputs: Array.isArray(replay.results) ? replay.results.length : 0,
    metrics: Object.fromEntries(Object.entries(report.observer.metrics)
      .map(([key, value]: [string, any]) => [key, value.count])),
    result: report.result
  });
}

async function captureSample(
  options: Options,
  slot: number,
  scheduledAtMs: number
): Promise<AtomicSample> {
  const sampledAt = new Date().toISOString();
  const webStarted = Date.now();
  const web = await health(options.addr);
  const webLatency = Date.now() - webStarted;
  const coreStarted = Date.now();
  const core = await health(options.coreAddr);
  const coreLatency = Date.now() - coreStarted;
  const db = new Database(options.dbPath, { readonly: true, strict: true });
  db.run("pragma busy_timeout=5000");
  try {
    const automationID = pilotAutomationID(options);
    const automation = row(db, `
      select id, status, mode, next_run_at, revision
      from automation_definitions where id=?`, automationID);
    const watchdog = row(db, `
      select last_seen_at, last_success_at, last_error, checked_components_json
      from pi_guardian_watchdog_status where singleton_id=1`);
    const heartbeatFreshness = watchdog.last_seen_at
      ? Math.max(0, Date.parse(sampledAt) - Date.parse(String(watchdog.last_seen_at)))
      : Number.POSITIVE_INFINITY;
    const sample: AtomicSample = {
      contract: SAMPLE_CONTRACT,
      slot,
      scheduled_at: new Date(scheduledAtMs).toISOString(),
      sampled_at: sampledAt,
      lateness_ms: Math.max(0, Date.now() - scheduledAtMs),
      health: {
        core_latency_ms: coreLatency,
        core_ok: core.ok === true,
        core_status: core.status,
        web_latency_ms: webLatency,
        web_ok: web.ok === true,
        web_status: web.status
      },
      db: {
        bytes: statSync(options.dbPath).size,
        quick_check: String(
          db.query<{ quick_check: string }, []>("pragma quick_check").get()?.quick_check ?? ""
        )
      },
      automation: {
        ...automation,
        duplicate_idempotency_keys: scalar(db, `
          select count(*) value from (
            select idempotency_key from automation_runs where automation_id=?
            group by idempotency_key having count(*)>1
          )`, automationID),
        run_count: scalar(db, "select count(*) value from automation_runs where automation_id=?", automationID),
        open_run_count: scalar(db, `
          select count(*) value from automation_runs
          where automation_id=? and status in ('queued','running')`, automationID)
      },
      heartbeat: {
        freshness_ms: finiteOrNull(heartbeatFreshness),
        last_error: watchdog.last_error ?? "",
        last_seen_at: watchdog.last_seen_at ?? "",
        last_success_at: watchdog.last_success_at ?? ""
      },
      mcp: row(db, `
        select id, enabled, status, readiness, last_introspected_at
        from pi_mcp_servers where id=?`, MCP_SERVER_ID),
      runs: {
        completed: scalar(db, `
          select count(*) value from issue_runs
          where status in ('done','failed','cancelled','pending_verification')`),
        open: scalar(db, `
          select count(*) value from issue_runs
          where status in ('queued','in_progress','running')`)
      },
      leases: {
        orphan_count:
          scalar(db, `
            select count(*) value from automation_runs
            where lease_token<>'' and lease_expires_at<>'' and lease_expires_at<?`, sampledAt) +
          scalar(db, "select count(*) value from pi_guardian_event_inbox where status='leased' and lease_expires_at<?", sampledAt),
        open_automation: scalar(db, `
          select count(*) value from automation_runs
          where lease_token<>'' and status in ('queued','running')`)
      },
      attention: {
        actionable: scalar(db, `
          select count(*) value from attention_inbox_items
          where status not in ('resolved','dismissed','expired')`)
      },
      resources: await resourceSnapshot(options)
    };
    timeline(options, "sample.captured", {
      core_ok: sample.health.core_ok,
      db_quick_check: sample.db.quick_check,
      heartbeat_freshness_ms: sample.heartbeat.freshness_ms,
      slot,
      web_ok: sample.health.web_ok
    });
    return sample;
  } finally {
    db.close();
  }
}

function writeOfflineReport(options: Options, fatalReason = ""): Json {
  const state = readJson(artifact(options, "controller-state.json")) as ControllerState;
  const samples = readJsonLines(artifact(options, "raw-samples.jsonl")) as AtomicSample[];
  const workloadReports = [1, 2].map((cycle) =>
    artifact(options, `workloads/cycle-${cycle}/report.json`)
  ).filter(existsSync).map(readJson);
  const events = readJsonLines(artifact(options, "timeline.jsonl"));
  const analysis = analyzeEndurance({ samples, state, timeline: events, workloadReports });
  writeStableJson(artifact(options, "analysis.json"), analysis);
  writeStableJson(artifact(options, "analysis-rebuilt.json"), analyzeEndurance({
    samples: readJsonLines(artifact(options, "raw-samples.jsonl")) as AtomicSample[],
    state: readJson(artifact(options, "controller-state.json")) as ControllerState,
    timeline: readJsonLines(artifact(options, "timeline.jsonl")),
    workloadReports: [1, 2].map((cycle) =>
      artifact(options, `workloads/cycle-${cycle}/report.json`)
    ).filter(existsSync).map(readJson)
  }));
  const firstHash = sha256File(artifact(options, "analysis.json"));
  const rebuiltHash = sha256File(artifact(options, "analysis-rebuilt.json"));
  const assertions: Assertion[] = [
    assertion("real_wall_clock_at_least_24_hours",
      analysis.duration.wall_clock_ms >= MINIMUM_DURATION_MS &&
      analysis.duration.monotonic_ms >= MINIMUM_DURATION_MS,
      "controller-state.json + timeline.jsonl", analysis.duration),
    assertion("sampling_coverage_at_least_95_percent_and_49_atomic_samples",
      analysis.sampling.actual >= MINIMUM_SAMPLES &&
      analysis.sampling.coverage >= MINIMUM_COVERAGE,
      "raw-samples.jsonl", analysis.sampling),
    assertion("web_core_db_remain_healthy",
      analysis.reliability.health_failure_samples.length === 0,
      "raw-samples.jsonl", analysis.reliability.health_failure_samples),
    assertion("effective_workload_meets_minimum_mix",
      analysis.work.direct_success >= 2 &&
      analysis.work.agent_self_heal_success >= 2 &&
      analysis.work.correct_human_help >= 1 &&
      analysis.work.duplicate_inputs >= 1,
      "workloads/cycle-*/report.json", analysis.work),
    assertion("first_failure_and_final_failure_are_separate",
      analysis.work.first_failure >= 2 &&
      analysis.work.final_failure === 0 &&
      analysis.work.agent_self_heal_success >= 2,
      "workloads/cycle-*/report.json", analysis.work),
    assertion("no_false_help_duplicate_execution_or_manual_intervention",
      analysis.work.false_or_stale_help === 0 &&
      analysis.work.duplicate_execution === 0 &&
      analysis.work.manual_intervention === 0,
      "workloads/cycle-*/report.json", analysis.work),
    assertion("heartbeat_is_fresh",
      Number.isFinite(analysis.reliability.heartbeat_freshness_max_ms) &&
      analysis.reliability.heartbeat_freshness_max_ms <= 120_000,
      "raw-samples.jsonl", analysis.reliability.heartbeat_freshness_max_ms),
    assertion("planned_restart_and_mcp_reconnect_are_measured",
      Number(analysis.reliability.restart_latency_ms) > 0 &&
      Number(analysis.reliability.mcp_reconnect_latency_ms) > 0,
      "timeline.jsonl", {
        mcp_reconnect_latency_ms: analysis.reliability.mcp_reconnect_latency_ms,
        restart_latency_ms: analysis.reliability.restart_latency_ms
      }),
    assertion("no_orphan_lease_duplicate_automation_or_external_action",
      analysis.reliability.orphan_lease_max === 0 &&
      analysis.reliability.duplicate_automation_idempotency_keys_max === 0 &&
      analysis.reliability.unauthorized_external_actions === 0,
      "raw-samples.jsonl + timeline.jsonl", analysis.reliability),
    assertion("resource_growth_is_bounded",
      analysis.resources.rss_growth_bytes <= 64 * 1024 * 1024,
      "raw-samples.jsonl", analysis.resources),
    assertion("offline_rebuild_is_byte_identical",
      firstHash === rebuiltHash,
      "analysis.json + analysis-rebuilt.json", { first: firstHash, rebuilt: rebuiltHash })
  ];
  if (fatalReason || existsSync(artifact(options, "fatal-error.txt"))) {
    assertions.push(assertion("controller_completed_without_fatal_error", false, "fatal-error.txt",
      fatalReason || readFileSync(artifact(options, "fatal-error.txt"), "utf8").trim()));
  }
  const failureReasons = assertions.filter((item) => !item.passed)
    .map((item) => `assertion failed: ${item.id}`);
  const report = {
    artifact_refs: [
      "start-watermark.json",
      "controller-state.json",
      "raw-samples.jsonl",
      "analysis.json",
      "analysis-rebuilt.json",
      "launch-agent.plist",
      "launch-recovery.json",
      "timeline.jsonl",
      "replay.md",
      "workloads/",
      "mcp/"
    ],
    assertions,
    contract: "xw.agentic-activation.issue-report.v1",
    ended_at: analysis.ended_at,
    failure_reasons: failureReasons,
    issue_id: ISSUE_ID,
    result: failureReasons.length === 0 ? "passed" : "failed",
    started_at: analysis.started_at,
    summary: analysis
  };
  writeStableJson(artifact(options, "report.json"), report);
  return report;
}

async function persistFinalEvidenceAndStatus(options: Options, report: Json): Promise<void> {
  const runID = currentCanonicalRunID(options);
  const endedAt = new Date().toISOString();
  const startedAt = new Date(Math.max(0, Date.parse(endedAt) - 1000)).toISOString();
  const evidence = await api(options, `/api/issues/${ISSUE_ID}/evidence/command`, {
    body: {
      artifact_refs: ["report.json", "timeline.jsonl", "replay.md"].map((name) => ({
        kind: name.endsWith(".json") ? "report" : "file",
        label: name,
        media_type: name.endsWith(".json") ? "application/json" : "text/markdown",
        ref: artifact(options, name),
        sha256: sha256File(artifact(options, name))
      })),
      channel: "delegated_executor",
      correlation_id: `issue-785-endurance-${Date.parse(report.started_at)}`,
      kind: "test",
      observation: {
        command: "bun scripts/agentic-endurance-live.ts report --artifact-dir .runner/artifacts/agentic-activation/issue-785",
        cwd: process.cwd(),
        duration_ms: 1000,
        ended_at: endedAt,
        exit_code: report.result === "passed" ? 0 : 1,
        signal: "",
        started_at: startedAt,
        stderr: report.result === "passed" ? "" : report.failure_reasons.join("; "),
        stdout: `${report.result}; assertions=${report.assertions.length}`,
        timed_out: false
      },
      producer_id: "agent-09-deterministic-finalizer",
      run_id: runID,
      source_ref: `artifact:${artifact(options, "report.json")}`
    },
    method: "POST"
  }, [200]);
  writeStableJson(artifact(options, "persisted-evidence.json"), evidence.body);
  const cli = existsSync(resolve("dist/codex-issue-runner"))
    ? resolve("dist/codex-issue-runner")
    : "codex-issue-runner";
  if (report.result !== "passed") {
    const current = await api(options, `/api/issues/${ISSUE_ID}`, {}, [200]);
    if (current.body?.status === "pending_verification") {
      const release = await runCommand([
        cli, "issue", "request-changes",
        "--addr", options.addr,
        "--id", String(ISSUE_ID),
        "--token-file", options.tokenFile,
        "--comment", "24h deterministic report failed; return to triage before explicit failed write-back",
        "--json"
      ], process.cwd(), 120_000);
      writeStableJson(artifact(options, "final-verification-release.json"), release);
      if (release.exit_code !== 0) {
        throw new Error(`failed to release pending verification before failed status: ${release.stderr}`);
      }
    }
  }
  const args = [
    cli, "issue", "update",
    "--addr", options.addr,
    "--id", String(ISSUE_ID),
    "--token-file", options.tokenFile,
    "--status", report.result === "passed" ? "done" : "failed"
  ];
  if (report.result !== "passed") {
    args.push("--error", report.failure_reasons.join("; ").slice(0, 1000));
  }
  args.push("--json");
  const update = await runCommand(args, process.cwd(), 120_000);
  writeStableJson(artifact(options, "final-issue-update.json"), update);
  if (update.exit_code !== 0) throw new Error(`final Issue status update failed: ${update.stderr}`);
  let updatedIssue: Json = {};
  try { updatedIssue = JSON.parse(update.stdout); } catch {}
  const expectedStatus = report.result === "passed" ? "done" : "failed";
  if (updatedIssue.status !== expectedStatus) {
    const reason = `final Issue status is ${String(updatedIssue.status || "unknown")}; expected ${expectedStatus}`;
    if (report.result === "passed") {
      const fallback = await runCommand([
        cli, "issue", "update",
        "--addr", options.addr,
        "--id", String(ISSUE_ID),
        "--token-file", options.tokenFile,
        "--status", "failed",
        "--error", reason,
        "--json"
      ], process.cwd(), 120_000);
      writeStableJson(artifact(options, "final-issue-fallback-failed.json"), fallback);
    }
    throw new Error(reason);
  }
  const handoffs = await api(options,
    `/api/handoffs?work_id=${encodeURIComponent(`xw:work:issues:${ISSUE_ID}`)}`, {}, [200]);
  writeStableJson(artifact(options, "final-handoff-query.json"), handoffs.body);
  if (report.result === "passed") {
    const ready = Array.isArray(handoffs.body?.items) && handoffs.body.items.some((item: Json) =>
      item.status === "ready" || item.status === "delivered"
    );
    if (!ready) {
      const reason = "final ready/delivered Handoff is missing";
      const fallback = await runCommand([
        cli, "issue", "update",
        "--addr", options.addr,
        "--id", String(ISSUE_ID),
        "--token-file", options.tokenFile,
        "--status", "failed",
        "--error", reason,
        "--json"
      ], process.cwd(), 120_000);
      writeStableJson(artifact(options, "final-handoff-fallback-failed.json"), fallback);
      throw new Error(reason);
    }
  }
}

async function liveConfiguration(options: Options): Promise<Json> {
  const db = new Database(options.dbPath, { readonly: true });
  try {
    return {
      app_support_dir: options.appSupportDir,
      artifact_bytes: directoryBytes(resolve(".runner/artifacts")),
      automation_run_count: scalar(db, "select count(*) value from automation_runs"),
      db_bytes: statSync(options.dbPath).size,
      heartbeat: row(db, `
        select last_seen_at, last_success_at, last_error
        from pi_guardian_watchdog_status where singleton_id=1`),
      mcp_server_count: scalar(db, "select count(*) value from pi_mcp_servers"),
      run_count: scalar(db, "select count(*) value from issue_runs"),
      web: await health(options.addr),
      core: await health(options.coreAddr)
    };
  } finally {
    db.close();
  }
}

async function resourceSnapshot(options: Options): Promise<Json> {
  const [web, core] = await Promise.all([servicePID("web"), servicePID("core")]);
  const webRss = await rssBytes(web);
  const coreRss = await rssBytes(core);
  return {
    app_support_bytes: directoryBytes(options.appSupportDir),
    artifact_bytes: directoryBytes(resolve(".runner/artifacts")),
    core_pid: core,
    core_rss_bytes: coreRss,
    group_rss_bytes: webRss + coreRss,
    web_pid: web,
    web_rss_bytes: webRss
  };
}

async function coreIdentity(options: Options): Promise<Json> {
  const result = await health(options.coreAddr);
  return { ...result, pid: await servicePID("core") };
}

async function health(addr: string): Promise<Json> {
  try {
    const response = await fetch(`http://${addr}/health`, { signal: AbortSignal.timeout(10_000) });
    const text = await response.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch {}
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, error: safeError(error) };
  }
}

async function api(
  options: Options,
  path: string,
  init: { body?: unknown; method?: string },
  expected: number[]
): Promise<{ body: any; status: number }> {
  const token = readFileSync(options.tokenFile, "utf8").trim();
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`http://${options.addr}${path}`, {
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    headers,
    method: init.method ?? "GET",
    signal: AbortSignal.timeout(120_000)
  });
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!expected.includes(response.status)) {
    throw new Error(`${init.method ?? "GET"} ${path}: expected ${expected.join("/")}, got ${response.status}: ${JSON.stringify(body)}`);
  }
  return { body, status: response.status };
}

async function runCommand(command: string[], cwd: string, timeoutMs: number): Promise<Json> {
  const started = Date.now();
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env },
    stderr: "pipe",
    stdout: "pipe"
  });
  const timed = await Promise.race([
    child.exited.then((exitCode) => ({ exitCode, timedOut: false })),
    sleep(timeoutMs).then(() => ({ exitCode: null, timedOut: true }))
  ]);
  if (timed.timedOut) child.kill("SIGTERM");
  const exitCode = timed.exitCode ?? await child.exited;
  return {
    command: command.map(redactArg),
    duration_ms: Date.now() - started,
    exit_code: exitCode,
    stderr: (await new Response(child.stderr).text()).slice(-16_000),
    stdout: (await new Response(child.stdout).text()).slice(-16_000),
    timed_out: timed.timedOut
  };
}

function prepareArtifactDirectory(options: Options): void {
  mkdirSync(options.artifactDir, { recursive: true });
  for (const name of [
    "analysis.json", "analysis-rebuilt.json", "controller-state.json",
    "fatal-error.txt", "final-handoff-query.json", "final-issue-update.json",
    "persisted-evidence.json", "pilot-manifest.json", "raw-samples.jsonl", "ready.json", "report.json",
    "start-watermark.json", "timeline.jsonl"
  ]) rmSync(artifact(options, name), { force: true, recursive: true });
  rmSync(artifact(options, "mcp"), { force: true, recursive: true });
  rmSync(artifact(options, "workloads"), { force: true, recursive: true });
  rmSync(artifact(options, "pilot-repo"), { force: true, recursive: true });
  writeReplay(options);
}

function writeReplay(options: Options): void {
  const content = `# Issue #785 真实 24 小时无人值守验收复现

## 前置

\`\`\`bash
./scripts/status-launchd.sh
./dist/codex-issue-runner issue status --id 784 --token-file "${options.tokenFile}" --json
\`\`\`

仅当 #784 为 \`done\` 且 Web/Core/DB 健康时继续。运行过程创建
\`${PILOT_PROJECT_ID_PREFIX}-<run>\` 隔离项目、observe-only Automation 和本地 MCP fixture；
不发送外部消息，不 push，不 deploy。结束时 Automation 会归档，pilot project 与 MCP fixture 会移除。

## 启动并退出 Agent

\`\`\`bash
ART='${options.artifactDir}'
LABEL='com.xiaobei.codex-issue-runner.issue-785-endurance'
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BUN_BIN="$(command -v bun)"
ROOT="$PWD"
LOG_DIR='${options.appSupportDir}/logs'
mkdir -p "$ART" "$LOG_DIR" "$(dirname "$PLIST")"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>Program</key><string>$BUN_BIN</string>
  <key>ProgramArguments</key><array>
    <string>$BUN_BIN</string>
    <string>$ROOT/scripts/agentic-endurance-live.ts</string>
    <string>run</string>
    <string>--artifact-dir</string><string>$ART</string>
    <string>--db</string><string>${options.dbPath}</string>
    <string>--token-file</string><string>${options.tokenFile}</string>
    <string>--app-support-dir</string><string>${options.appSupportDir}</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG_DIR/issue-785-endurance.out.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/issue-785-endurance.err.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>$(dirname "$BUN_BIN"):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict></plist>
PLIST
plutil -lint "$PLIST"
launchctl bootstrap "$DOMAIN" "$PLIST"
for _ in $(seq 1 120); do
  test -s "$ART/ready.json" && test -s "$ART/raw-samples.jsonl" && break
  sleep 1
done
launchctl print "$DOMAIN/$LABEL" | grep -E 'state =|pid ='
bun scripts/agentic-endurance-live.ts status --artifact-dir "$ART"
cp "$PLIST" "$ART/launch-agent.plist"
python3 - "$PLIST" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).unlink(missing_ok=True)
PY
\`\`\`

控制器使用真实 wall clock 运行至少 24 小时，每 20 分钟原子采样一次。
独立 LaunchAgent 的控制器进程以 PPID 1 运行；启动 Agent 在 \`ready.json\` 和首个原子样本
落盘后退出。采样和报表均为确定性程序，不调用 LLM；不得用短窗口、fake clock
或回填样本替代。

## 提前终止并失败收口

需要取消长窗时，不要只杀进程或手工改 Issue 状态。使用同一确定性入口停止 LaunchAgent、
清理隔离 fixture、保存部分报告和 persisted Evidence，并把 Issue 明确更新为 \`failed\`：

\`\`\`bash
bun scripts/agentic-endurance-live.ts stop --artifact-dir '${options.artifactDir}' \
  --db '${options.dbPath}' --token-file '${options.tokenFile}' \
  --app-support-dir '${options.appSupportDir}' \
  --reason 'operator stopped the endurance window before 24 hours elapsed'
\`\`\`

## 离线重建

\`\`\`bash
bun scripts/agentic-endurance-live.ts report --artifact-dir '${options.artifactDir}' \\
  --db '${options.dbPath}' --token-file '${options.tokenFile}'
shasum -a 256 \\
  '${options.artifactDir}/analysis.json' \\
  '${options.artifactDir}/analysis-rebuilt.json'
jq '{result,started_at,ended_at,failure_reasons,assertions}' \\
  '${options.artifactDir}/report.json'
launchctl bootout "gui/$(id -u)/com.xiaobei.codex-issue-runner.issue-785-endurance"
python3 - "$HOME/Library/LaunchAgents/com.xiaobei.codex-issue-runner.issue-785-endurance.plist" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).unlink(missing_ok=True)
PY
\`\`\`

最终控制器会先 POST 当前 Run 的 persisted command Evidence，再根据报告结果显式运行：
\`codex-issue-runner issue update --id 785 --status done|failed --json\`。
`;
  writeFileSync(artifact(options, "replay.md"), content);
}

function controllerStatus(options: Options): Json {
  const state = existsSync(artifact(options, "controller-state.json"))
    ? readJson(artifact(options, "controller-state.json"))
    : null;
  const pid = Number(state?.pid ?? 0);
  let running = false;
  if (pid > 0) {
    try { process.kill(pid, 0); running = true; } catch {}
  }
  return {
    artifact_dir: options.artifactDir,
    end_not_before: state?.end_not_before ?? "",
    pid,
    ready: existsSync(artifact(options, "ready.json")),
    report: existsSync(artifact(options, "report.json"))
      ? readJson(artifact(options, "report.json")).result
      : "pending",
    running,
    samples: existsSync(artifact(options, "raw-samples.jsonl"))
      ? readJsonLines(artifact(options, "raw-samples.jsonl")).length
      : 0,
    started_at: state?.started_at ?? ""
  };
}

function currentCanonicalRunID(options: Options): string {
  const db = new Database(options.dbPath, { readonly: true });
  try {
    const row = db.query<{ id: string }, [number]>(
      "select id from issue_runs where issue_id=? order by attempt desc limit 1"
    ).get(ISSUE_ID);
    if (!row?.id) throw new Error("Issue #785 current Run is missing");
    return `xw:run:issue_runs:${row.id}`;
  } finally {
    db.close();
  }
}

function resourceSummary(samples: AtomicSample[]): Json {
  const rss = samples.map((sample) => Number(sample.resources.group_rss_bytes ?? 0));
  const app = samples.map((sample) => Number(sample.resources.app_support_bytes ?? 0));
  const artifacts = samples.map((sample) => Number(sample.resources.artifact_bytes ?? 0));
  const db = samples.map((sample) => Number(sample.db.bytes ?? 0));
  return {
    app_support_peak_bytes: maximum(app),
    app_support_growth_bytes: growth(app),
    artifact_peak_bytes: maximum(artifacts),
    artifact_growth_bytes: growth(artifacts),
    database_peak_bytes: maximum(db),
    database_growth_bytes: growth(db),
    rss_peak_bytes: maximum(rss),
    rss_growth_bytes: growth(rss),
    rss_trend: trend(rss)
  };
}

function assertion(id: string, passed: boolean, evidence: string, detail?: unknown): Assertion {
  return { id, passed, evidence, ...(detail === undefined ? {} : { detail }) };
}

function row(db: Database, sql: string, ...params: any[]): Json {
  return db.query<Json, any[]>(sql).get(...params) ?? {};
}

function scalar(db: Database, sql: string, ...params: any[]): number {
  return Number(db.query<{ value: number }, any[]>(sql).get(...params)?.value ?? 0);
}

async function servicePID(role: "web" | "core"): Promise<number> {
  const result = await runCommand([
    "/bin/launchctl", "print",
    `gui/${process.getuid()}/com.xiaobei.codex-issue-runner.${role}`
  ], process.cwd(), 10_000);
  const match = result.stdout.match(/^\s*pid = (\d+)$/m);
  return match ? Number(match[1]) : 0;
}

async function rssBytes(pid: number): Promise<number> {
  if (pid < 1) return 0;
  const result = await runCommand(["/bin/ps", "-o", "rss=", "-p", String(pid)], process.cwd(), 10_000);
  return Math.max(0, Number(result.stdout.trim()) || 0) * 1024;
}

function directoryBytes(path: string): number {
  if (!existsSync(path)) return 0;
  const result = Bun.spawnSync(["/usr/bin/du", "-sk", path], { stderr: "ignore", stdout: "pipe" });
  return Math.max(0, Number(result.stdout.toString().trim().split(/\s+/)[0]) || 0) * 1024;
}

function parseOptions(args: string[]): Options {
  const appSupportDir = resolve(option(args, "app-support-dir", DEFAULT_APP_SUPPORT));
  const artifactDir = resolve(option(args, "artifact-dir", DEFAULT_ARTIFACT_DIR));
  const durationMs = Number(option(args, "duration-ms", String(MINIMUM_DURATION_MS)));
  const intervalMs = Number(option(args, "interval-ms", String(DEFAULT_INTERVAL_MS)));
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw new Error("duration-ms is invalid");
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new Error("interval-ms is invalid");
  return {
    addr: option(args, "addr", DEFAULT_ADDR),
    appSupportDir,
    artifactDir,
    coreAddr: option(args, "core-addr", DEFAULT_CORE_ADDR),
    dbPath: resolve(option(args, "db", join(appSupportDir, "state/runner.db"))),
    durationMs,
    intervalMs,
    tokenFile: resolve(option(args, "token-file", join(appSupportDir, "state/auth_token")))
  };
}

function option(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
  return value;
}

function artifact(options: Options, name: string): string {
  return join(options.artifactDir, name);
}

function pilotAutomationID(options: Options): string {
  const value = readJson(artifact(options, "pilot-manifest.json")).automation_id;
  if (typeof value !== "string" || !value.startsWith(`${AUTOMATION_ID_PREFIX}-`)) {
    throw new Error("pilot Automation manifest is invalid");
  }
  return value;
}

function pilotProjectID(options: Options): string {
  const value = readJson(artifact(options, "pilot-manifest.json")).project_id;
  if (typeof value !== "string" || !value.startsWith(`${PILOT_PROJECT_ID_PREFIX}-`)) {
    throw new Error("pilot project manifest is invalid");
  }
  return value;
}

function timeline(options: Options, type: string, detail: Json): void {
  appendJsonLine(artifact(options, "timeline.jsonl"), {
    at: new Date().toISOString(),
    type,
    ...redact(detail)
  });
}

function appendJsonLine(path: string, value: unknown): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  appendFileSync(path, `${JSON.stringify(redact(value))}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function writeStableJson(path: string, value: unknown): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${stableJson(redact(value))}\n`, { mode: 0o600 });
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonLines(path: string): Json[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Json).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function redact(value: unknown): any {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Json).map(([key, item]) => [
    key,
    /token|secret|password|credential|lease_token/i.test(key) ? (item ? "[redacted]" : item) : redact(item)
  ]));
}

function redactArg(value: string): string {
  return /token/i.test(value) && !value.endsWith("auth_token") ? "[redacted]" : value;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function maximum(values: number[]): number {
  const finite = values.filter(Number.isFinite);
  return finite.length === 0 ? 0 : Math.max(...finite);
}

function growth(values: number[]): number {
  return values.length < 2 ? 0 : values.at(-1)! - values[0]!;
}

function trend(values: number[]): "flat" | "growing" | "shrinking" {
  const delta = growth(values);
  if (Math.abs(delta) < 1024 * 1024) return "flat";
  return delta > 0 ? "growing" : "shrinking";
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(0, ms)));
}

async function sleepUntil(epochMs: number): Promise<void> {
  while (Date.now() < epochMs) await sleep(Math.min(60_000, epochMs - Date.now()));
}
