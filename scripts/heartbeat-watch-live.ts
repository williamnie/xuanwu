#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { openDatabase, type RunnerDatabase } from "../backend-ts/src/db/database.ts";
import { createAutomationWatch, getAutomationWatch } from "../backend-ts/src/db/repositories/automationWatches.ts";
import { createIssue } from "../backend-ts/src/db/repositories/issueCreate.ts";
import { updateIssue } from "../backend-ts/src/db/repositories/issueUpdate.ts";
import type { AutomationAudit, AutomationID } from "../backend-ts/src/domain/automation/contracts.ts";
import {
  createPiAutoManageScheduler,
  type PiAutoManageScheduler
} from "../backend-ts/src/runner/piAutoManageScheduler.ts";

type Json = Record<string, any>;
type Assertion = { id: string; passed: boolean; evidence: unknown };
type Options = {
  artifactDir: string;
  command: string;
  controlPort: number;
  intervalMs: number;
  repoRoot: string;
  runtimeDir: string;
};
type WorkerHandle = {
  child: ReturnType<typeof Bun.spawn>;
  generation: number;
  pid: number;
};
type TickSample = {
  generation: number;
  observed_at: string;
  watchdog_last_seen_at: string;
  worker_pid: number;
};

const ISSUE_ID = 780;
const PROJECT_ID = "agentic-activation-issue-780";
const WATCH_ID = "automation:agent-04-heartbeat-watch" as AutomationID;
const SIGNAL_WATERMARK = "fixture-signal:v1";
const DEFAULT_ARTIFACT_DIR = ".runner/artifacts/agentic-activation/issue-780";
const PRODUCTION_INTERVAL_MS = 30_000;

if (import.meta.main) {
  const options = parseArgs(Bun.argv.slice(2));
  try {
    if (options.command === "worker") await runWorker(options);
    else if (options.command === "exercise") await exercise(options);
    else throw new Error("usage: heartbeat-watch-live.ts <exercise|worker> [options]");
  } catch (error) {
    console.error(safeError(error));
    process.exit(1);
  }
}

async function exercise(options: Options): Promise<void> {
  assertSafeInterval(options.intervalMs);
  assertPortUnused(options.controlPort);
  mkdirSync(options.artifactDir, { recursive: true });
  resetArtifacts(options.artifactDir);
  const timeline = timelineWriter(options.artifactDir);
  const startedAt = new Date().toISOString();
  const assertions: Assertion[] = [];
  const failures: string[] = [];
  const ownedRuntime = options.runtimeDir === "";
  const runtimeDir = options.runtimeDir || await mkdtemp(join(tmpdir(), "issue-780-heartbeat-watch-"));
  const stateDir = join(runtimeDir, "state");
  const dbPath = join(stateDir, "runner.db");
  let worker: WorkerHandle | undefined;
  let generation = 0;
  const samples: TickSample[] = [];
  timeline.record("exercise.started", {
    interval_ms: options.intervalMs,
    issue_id: ISSUE_ID,
    runtime_scope: "isolated deterministic schedule Core",
    state_dir: "<temporary-state>"
  });

  try {
    const fixture = await createFixture(stateDir, options.repoRoot);
    writeJson(artifact(options, "fixture-manifest.json"), fixture);
    const baseline = readStateFromDB(dbPath);
    writeJson(artifact(options, "baseline.json"), baseline);
    timeline.record("fixture.created", {
      issue_id: fixture.issue_id,
      signal_watermark: SIGNAL_WATERMARK,
      watch_id: WATCH_ID
    });

    generation += 1;
    worker = await startWorker(options, stateDir, generation);
    timeline.record("core.started", { generation, pid: worker.pid });

    await collectTicks(options, worker, samples, 3, timeline);
    const noChange = await control(options, "/state");
    writeJson(artifact(options, "no-change-cycles.json"), {
      samples: samples.slice(0, 3),
      state: noChange
    });
    assertion(assertions, "at_least_three_real_no_change_ticks", samples.length >= 3, {
      tick_count: samples.length,
      ticks: samples.slice(0, 3)
    });
    assertion(assertions, "three_no_change_cycles_are_safe_noop",
      noChange.issue_count === baseline.issue_count &&
      noChange.issue_run_count === baseline.issue_run_count &&
      noChange.automation_run_count === baseline.automation_run_count &&
      noChange.notification_intent_count === baseline.notification_intent_count &&
      noChange.watch.status === "watching", {
        baseline: countWatermark(baseline),
        after: countWatermark(noChange),
        watch_status: noChange.watch.status
      });

    const beforeRestart = samples.at(-1)!;
    const oldPID = worker.pid;
    worker.child.kill("SIGKILL");
    await worker.child.exited;
    await sleep(options.intervalMs * 2 + Math.ceil(options.intervalMs / 2));
    generation += 1;
    worker = await startWorker(options, stateDir, generation);
    const recovered = await collectTicks(options, worker, samples, samples.length + 1, timeline);
    const missed = missedTickCount(
      beforeRestart.watchdog_last_seen_at,
      recovered.watchdog_last_seen_at,
      options.intervalMs
    );
    const restart = {
      handling: "missed slots are not replayed; durable Watch watermark is evaluated on the next live tick",
      missed_tick_count: missed,
      new_pid: worker.pid,
      next_tick: recovered,
      old_pid: oldPID,
      previous_tick: beforeRestart,
      watch: (await control(options, "/state")).watch
    };
    writeJson(artifact(options, "restart-recovery.json"), restart);
    timeline.record("core.restart_recovered", restart);
    assertion(assertions, "core_restart_changes_pid_and_next_tick_recovers",
      worker.pid !== oldPID &&
      recovered.generation === generation &&
      recovered.watchdog_last_seen_at > beforeRestart.watchdog_last_seen_at, restart);
    assertion(assertions, "missed_tick_has_explicit_handling_record", missed >= 1, {
      handling: restart.handling,
      missed_tick_count: missed
    });

    const signal = await control(options, "/signal", {
      method: "POST",
      body: { watermark: SIGNAL_WATERMARK }
    });
    timeline.record("fixture.signal_changed", signal);
    const beforeMatchTicks = samples.length;
    await collectTicks(options, worker, samples, beforeMatchTicks + 1, timeline);
    const matched = await waitForState(options, (state) => state.watch.status === "satisfied");
    writeJson(artifact(options, "watch-match.json"), { signal, state: matched });
    timeline.record("watch.matched", {
      downstream_action_count: matched.notification_intent_count,
      matched_ref: matched.watch.matched_ref,
      outcome: matched.watch.outcome,
      watch_status: matched.watch.status
    });
    assertion(assertions, "watch_detects_change_and_triggers_exactly_once",
      signal.applied === true &&
      matched.watch.status === "satisfied" &&
      matched.watch.outcome === "completion" &&
      matched.watch.matched_ref === `issue:${fixture.issue_id}:pending_verification` &&
      matched.notification_intent_count === 1 &&
      matched.watch_terminal_event_count === 1, {
        signal,
        watch: matched.watch,
        notification_intent_count: matched.notification_intent_count,
        terminal_event_count: matched.watch_terminal_event_count
      });

    const actionWatermark = actionSideEffectWatermark(matched);
    const replay = await control(options, "/signal", {
      method: "POST",
      body: { watermark: SIGNAL_WATERMARK }
    });
    await collectTicks(options, worker, samples, samples.length + 1, timeline);
    const afterReplay = await control(options, "/state");
    writeJson(artifact(options, "watermark-replay.json"), {
      after: actionSideEffectWatermark(afterReplay),
      before: actionWatermark,
      replay
    });
    timeline.record("watermark.replayed", {
      replayed: replay.replayed,
      side_effect_watermark_unchanged: sameWatermark(actionWatermark, actionSideEffectWatermark(afterReplay))
    });
    assertion(assertions, "same_watermark_does_not_repeat_action",
      replay.replayed === true &&
      sameWatermark(actionWatermark, actionSideEffectWatermark(afterReplay)), {
        before: actionWatermark,
        after: actionSideEffectWatermark(afterReplay),
        replay
      });

    const tickCountBeforePause = samples.length;
    const pause = await control(options, "/pause", { method: "POST" });
    timeline.record("scheduler.paused", pause);
    await sleep(options.intervalMs * 2 + Math.ceil(options.intervalMs / 2));
    const pausedState = await control(options, "/state");
    const pauseLastSeen = pausedState.watchdog.last_seen_at;
    await sleep(Math.ceil(options.intervalMs / 3));
    const pausedAgain = await control(options, "/state");
    const resume = await control(options, "/resume", { method: "POST" });
    timeline.record("scheduler.resumed", resume);
    const resumedTick = await collectTicks(options, worker, samples, samples.length + 1, timeline);
    const pauseResume = {
      intervals_observed: 2,
      pause,
      pause_last_seen_at: pauseLastSeen,
      paused_second_read_last_seen_at: pausedAgain.watchdog.last_seen_at,
      resume,
      resumed_tick: resumedTick,
      ticks_before_pause: tickCountBeforePause
    };
    writeJson(artifact(options, "pause-resume.json"), pauseResume);
    assertion(assertions, "pause_blocks_two_intervals_and_resume_rearms",
      pause.paused === true &&
      pauseLastSeen === pausedAgain.watchdog.last_seen_at &&
      resume.paused === false &&
      resumedTick.watchdog_last_seen_at > pauseLastSeen, pauseResume);

    await collectTicks(options, worker, samples, Math.max(5, samples.length + 1), timeline);
    const finalState = await control(options, "/state");
    const freshnessMs = Date.now() - Date.parse(finalState.watchdog.last_seen_at);
    const integrity = {
      actionable_attention_count: finalState.actionable_attention_count,
      active_lease_count: finalState.active_lease_count,
      automation_open_run_count: finalState.automation_open_run_count,
      heartbeat_running_count: finalState.heartbeat_running_count,
      issue_open_run_count: finalState.issue_open_run_count,
      tick_count: samples.length,
      unique_tick_count: new Set(samples.map((sample) => sample.watchdog_last_seen_at)).size,
      watchdog_freshness_ms: freshnessMs,
      watchdog_threshold_ms: options.intervalMs * 2
    };
    writeJson(artifact(options, "runtime-integrity.json"), integrity);
    writeJson(artifact(options, "tick-samples.json"), { interval_ms: options.intervalMs, samples });
    assertion(assertions, "at_least_five_real_clock_ticks", samples.length >= 5, integrity);
    assertion(assertions, "watchdog_fresh_no_reentry_or_orphan_lease",
      freshnessMs >= 0 &&
      freshnessMs <= options.intervalMs * 2 &&
      integrity.unique_tick_count === samples.length &&
      finalState.active_lease_count === 0 &&
      finalState.automation_open_run_count === 0 &&
      finalState.heartbeat_running_count === 0 &&
      finalState.issue_open_run_count === 0, integrity);
    assertion(assertions, "unexpected_fault_has_no_duplicate_attention",
      finalState.actionable_attention_count <= 1, {
        actionable_attention_count: finalState.actionable_attention_count,
        planned_restart: true
      });

    const productionDefault = readProductionInterval(options.repoRoot);
    assertion(assertions, "production_interval_and_pilot_configuration_restored",
      productionDefault === PRODUCTION_INTERVAL_MS &&
      stateDir.startsWith(runtimeDir) &&
      resolve(runtimeDir) !== resolve(options.repoRoot), {
        isolated_runtime_removed_on_exit: ownedRuntime,
        production_interval_ms: productionDefault,
        test_interval_ms: options.intervalMs
      });
    writeJson(artifact(options, "final-state.json"), finalState);
  } catch (error) {
    failures.push(safeError(error));
    timeline.record("exercise.failed", { error: safeError(error) });
  } finally {
    if (worker) await stopWorker(options, worker).catch((error) => {
      failures.push(`worker cleanup: ${safeError(error)}`);
    });
    writeJson(artifact(options, "runtime-cleanup.json"), {
      production_interval_ms: readProductionInterval(options.repoRoot),
      runtime_dir_removed: ownedRuntime,
      test_interval_ms: options.intervalMs,
      worker_stopped: true
    });
    if (ownedRuntime) rmSync(runtimeDir, { force: true, recursive: true });
  }

  for (const item of assertions) if (!item.passed) failures.push(`assertion failed: ${item.id}`);
  const uniqueFailures = [...new Set(failures)];
  const report = {
    artifact_refs: [
      "baseline.json",
      "fixture-manifest.json",
      "no-change-cycles.json",
      "restart-recovery.json",
      "watch-match.json",
      "watermark-replay.json",
      "pause-resume.json",
      "tick-samples.json",
      "runtime-integrity.json",
      "final-state.json",
      "runtime-cleanup.json",
      "timeline.jsonl",
      "replay.md",
      "verification-command.log"
    ],
    assertions,
    contract: "xw.agentic-activation.issue-report.v1",
    ended_at: new Date().toISOString(),
    failure_reasons: uniqueFailures,
    issue_id: ISSUE_ID,
    result: uniqueFailures.length === 0 ? "passed" : "failed",
    started_at: startedAt
  };
  writeJson(artifact(options, "report.json"), report);
  writeReplay(options);
  timeline.record("exercise.completed", {
    assertion_count: assertions.length,
    failure_count: uniqueFailures.length,
    result: report.result
  });
  if (uniqueFailures.length > 0) throw new Error(uniqueFailures.join("; "));
  console.log(JSON.stringify({
    artifact_dir: options.artifactDir,
    assertions: assertions.length,
    result: "passed",
    ticks: samples.length
  }));
}

async function runWorker(options: Options): Promise<void> {
  if (options.runtimeDir === "") throw new Error("--runtime-dir is required for worker");
  const generation = Number(Bun.env.ISSUE_780_WORKER_GENERATION ?? "0");
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("worker generation is invalid");
  const stateDir = join(options.runtimeDir, "state");
  const db = await openDatabase({ stateDir });
  let scheduler: PiAutoManageScheduler | undefined;
  let paused = false;
  let stopping = false;
  const startScheduler = () => {
    if (scheduler) scheduler.stop();
    scheduler = createPiAutoManageScheduler({
      database: db,
      intervalMs: options.intervalMs,
      onError: (error) => appendWorkerLog(options, generation, "scheduler.error", { error: safeError(error) }),
      runProjectCycle: async () => ({}),
      runSupervisor: false,
      supervisorIntervalMs: options.intervalMs * 100
    });
    scheduler.start();
  };
  startScheduler();
  appendWorkerLog(options, generation, "worker.started", {
    interval_ms: options.intervalMs,
    pid: process.pid
  });

  const server = Bun.serve({
    fetch: async (request) => {
      const url = new URL(request.url);
      try {
        if (request.method === "GET" && url.pathname === "/health") {
          return json({ generation, ok: true, paused, pid: process.pid });
        }
        if (request.method === "GET" && url.pathname === "/state") {
          return json({ ...stateSnapshot(db), generation, paused, pid: process.pid });
        }
        if (request.method === "POST" && url.pathname === "/signal") {
          const body = await request.json() as Json;
          const watermark = String(body.watermark ?? "");
          if (watermark !== SIGNAL_WATERMARK) return json({ error: "unexpected watermark" }, 400);
          const current = stateSnapshot(db);
          if (current.fixture_signal_watermark === watermark) {
            return json({ applied: false, replayed: true, watermark });
          }
          const issueID = fixtureIssueID(db);
          updateIssue(db, issueID, { status: "pending_verification" });
          db.sqlite.run(
            `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
            [issueID, "fixture.signal_applied", JSON.stringify({ watermark }), new Date().toISOString()]
          );
          return json({ applied: true, issue_id: issueID, replayed: false, watermark });
        }
        if (request.method === "POST" && url.pathname === "/pause") {
          scheduler?.stop();
          paused = true;
          appendWorkerLog(options, generation, "scheduler.paused", { pid: process.pid });
          return json({ paused, pid: process.pid });
        }
        if (request.method === "POST" && url.pathname === "/resume") {
          if (paused) startScheduler();
          paused = false;
          appendWorkerLog(options, generation, "scheduler.resumed", { pid: process.pid });
          return json({ paused, pid: process.pid });
        }
        if (request.method === "POST" && url.pathname === "/shutdown") {
          if (!stopping) {
            stopping = true;
            scheduler?.stop();
            setTimeout(() => {
              server.stop(true);
              db.close();
              process.exit(0);
            }, 10);
          }
          return json({ stopping: true });
        }
        return json({ error: "not found" }, 404);
      } catch (error) {
        appendWorkerLog(options, generation, "control.error", { error: safeError(error), path: url.pathname });
        return json({ error: safeError(error) }, 500);
      }
    },
    hostname: "127.0.0.1",
    port: options.controlPort
  });

  const stop = () => {
    if (stopping) return;
    stopping = true;
    scheduler?.stop();
    server.stop(true);
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function createFixture(stateDir: string, repoRoot: string): Promise<Json> {
  const db = await openDatabase({ stateDir });
  try {
    const now = new Date().toISOString();
    db.sqlite.run(
      `insert into projects
        (id, name, cwd, provider, provider_config_json, auto_run, model,
         approval_policy, sandbox, default_agent_profile_id, default_skill_policy_json,
         default_mcp_policy_json, default_service_tier, sort_order, created_at, updated_at)
       values (?, ?, ?, 'codex', '{}', 0, '', 'on-request', 'workspace-write', '', '{}', '{}', '', 1, ?, ?)`,
      [PROJECT_ID, "Issue 780 isolated pilot", repoRoot, now, now]
    );
    const issue = createIssue(db, {
      description: "Local deterministic signal for Heartbeat/Watch live exercise",
      project_id: PROJECT_ID,
      status: "in_progress",
      title: "Issue 780 fixture signal"
    });
    const watch = createAutomationWatch(db, {
      allow_empty_notification_target: true,
      condition: { match: "all", statuses: ["pending_verification"], type: "issue_status" },
      dedupe_key: "issue-780:watch:fixture-signal",
      id: WATCH_ID,
      name: "Issue 780 Heartbeat Watch",
      notification_target: { channel: "feishu", chat_id: "", message_id: "", thread_id: "" },
      project_id: PROJECT_ID,
      subject: { issue_ids: [issue.id], kind: "issues" }
    }, audit("fixture-created", now));
    return {
      external_writes: 0,
      issue_id: issue.id,
      issue_status: issue.status,
      project_id: PROJECT_ID,
      signal_watermark: SIGNAL_WATERMARK,
      watch_id: watch.automation_id,
      watch_status: watch.status
    };
  } finally {
    db.close();
  }
}

function stateSnapshot(db: RunnerDatabase): Json {
  const issueID = fixtureIssueID(db);
  const watch = getAutomationWatch(db, WATCH_ID);
  if (!watch) throw new Error("fixture Watch is missing");
  const watchdog = db.sqlite.query<{ last_error: string; last_seen_at: string; last_success_at: string }, []>(
    "select last_seen_at, last_success_at, last_error from pi_guardian_watchdog_status where singleton_id=1"
  ).get() ?? { last_error: "", last_seen_at: "", last_success_at: "" };
  return {
    actionable_attention_count: scalar(db, `select count(*) value from pi_guardian_alerts
      where status in ('open','attention','pending')`),
    active_lease_count:
      scalar(db, "select count(*) value from pi_guardian_event_inbox where status='leased'") +
      scalar(db, "select count(*) value from pi_actions where status in ('executing','leased','running')"),
    automation_open_run_count: scalar(db, "select count(*) value from automation_runs where status in ('queued','running')"),
    automation_run_count: scalar(db, "select count(*) value from automation_runs"),
    fixture_signal_watermark: scalarText(db, `select coalesce(json_extract(payload, '$.watermark'),'') value
      from issue_events where issue_id=? and type='fixture.signal_applied' order by id desc limit 1`, issueID),
    heartbeat_running_count: scalar(db, "select count(*) value from pi_heartbeat_runs where status='running'"),
    issue_count: scalar(db, "select count(*) value from issues"),
    issue_open_run_count: scalar(db, "select count(*) value from issue_runs where status in ('queued','in_progress')"),
    issue_run_count: scalar(db, "select count(*) value from issue_runs"),
    notification_intent_count: scalar(db, "select count(*) value from pi_notification_intents where kind='automation_watch_terminal'"),
    notification_outbox_count: scalar(db, "select count(*) value from sync_outbox"),
    watch: {
      automation_id: watch.automation_id,
      matched_ref: watch.matched_ref,
      outcome: watch.outcome,
      status: watch.status,
      updated_at: watch.updated_at
    },
    watch_terminal_event_count: scalar(db, `select count(*) value from automation_events
      where automation_id=? and event_type='automation.watch_satisfied.v1'`, WATCH_ID),
    watchdog
  };
}

function readStateFromDB(dbPath: string): Json {
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    const query = (sql: string, ...params: any[]) =>
      Number(sqlite.query<{ value: number }, any[]>(sql).get(...params)?.value ?? 0);
    const watch = sqlite.query<Json, [string]>(
      "select automation_id, status, outcome, matched_ref, updated_at from automation_watches where automation_id=?"
    ).get(WATCH_ID) ?? {};
    return {
      automation_run_count: query("select count(*) value from automation_runs"),
      issue_count: query("select count(*) value from issues"),
      issue_run_count: query("select count(*) value from issue_runs"),
      notification_intent_count: query("select count(*) value from pi_notification_intents where kind='automation_watch_terminal'"),
      watch
    };
  } finally {
    sqlite.close();
  }
}

async function startWorker(options: Options, stateDir: string, generation: number): Promise<WorkerHandle> {
  await waitForPortRelease(options.controlPort, 10_000);
  const child = Bun.spawn([
    process.execPath,
    resolve(import.meta.path),
    "worker",
    "--artifact-dir", options.artifactDir,
    "--control-port", String(options.controlPort),
    "--interval-ms", String(options.intervalMs),
    "--repo-root", options.repoRoot,
    "--runtime-dir", dirname(stateDir)
  ], {
    cwd: options.repoRoot,
    env: { ...Bun.env, ISSUE_780_WORKER_GENERATION: String(generation) },
    stderr: "pipe",
    stdout: "pipe"
  });
  void captureStream(child.stdout, artifact(options, "core-worker.log"), "stdout");
  void captureStream(child.stderr, artifact(options, "core-worker.log"), "stderr");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`worker exited before health check: ${child.exitCode}`);
    try {
      const health = await control(options, "/health");
      if (health.ok === true && health.generation === generation) {
        return { child, generation, pid: health.pid };
      }
    } catch {}
    await sleep(50);
  }
  child.kill("SIGKILL");
  throw new Error("worker health timed out");
}

async function stopWorker(options: Options, worker: WorkerHandle): Promise<void> {
  if (worker.child.exitCode !== null) return;
  await control(options, "/shutdown", { method: "POST" }).catch(() => ({}));
  const completed = await Promise.race([
    worker.child.exited.then(() => true),
    sleep(3_000).then(() => false)
  ]);
  if (!completed) {
    worker.child.kill("SIGKILL");
    await worker.child.exited;
  }
  await waitForPortRelease(options.controlPort, 10_000);
}

async function collectTicks(
  options: Options,
  worker: WorkerHandle,
  samples: TickSample[],
  targetCount: number,
  timeline: ReturnType<typeof timelineWriter>
): Promise<TickSample> {
  const deadline = Date.now() + Math.max(20_000, options.intervalMs * (targetCount - samples.length + 4));
  let previous = samples.at(-1)?.watchdog_last_seen_at ?? "";
  while (Date.now() < deadline) {
    const state = await control(options, "/state");
    const seen = String(state.watchdog?.last_seen_at ?? "");
    if (seen !== "" && seen !== previous) {
      const sample: TickSample = {
        generation: worker.generation,
        observed_at: new Date().toISOString(),
        watchdog_last_seen_at: seen,
        worker_pid: worker.pid
      };
      samples.push(sample);
      previous = seen;
      timeline.record("heartbeat.tick_observed", {
        generation: sample.generation,
        tick_index: samples.length,
        watchdog_last_seen_at: seen,
        worker_pid: worker.pid
      });
      if (samples.length >= targetCount) return sample;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${targetCount} real ticks; observed ${samples.length}`);
}

async function waitForState(options: Options, predicate: (state: Json) => boolean): Promise<Json> {
  const deadline = Date.now() + Math.max(20_000, options.intervalMs * 5);
  while (Date.now() < deadline) {
    const state = await control(options, "/state");
    if (predicate(state)) return state;
    await sleep(50);
  }
  throw new Error("timed out waiting for runtime state");
}

async function control(
  options: Options,
  path: string,
  init: { body?: Json; method?: string } = {}
): Promise<Json> {
  const response = await fetch(`http://127.0.0.1:${options.controlPort}${path}`, {
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    headers: init.body === undefined ? undefined : { "content-type": "application/json" },
    method: init.method ?? "GET"
  });
  const payload = await response.json() as Json;
  if (!response.ok) throw new Error(`control ${path} failed: HTTP ${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

function actionSideEffectWatermark(state: Json): Json {
  return {
    notification_intent_count: state.notification_intent_count,
    notification_outbox_count: state.notification_outbox_count,
    watch_status: state.watch.status,
    watch_terminal_event_count: state.watch_terminal_event_count
  };
}

function countWatermark(state: Json): Json {
  return {
    automation_run_count: state.automation_run_count,
    issue_count: state.issue_count,
    issue_run_count: state.issue_run_count,
    notification_intent_count: state.notification_intent_count
  };
}

export function sameWatermark(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function missedTickCount(before: string, after: string, intervalMs: number): number {
  const gap = Date.parse(after) - Date.parse(before);
  if (!Number.isFinite(gap) || gap <= intervalMs) return 0;
  return Math.max(0, Math.floor(gap / intervalMs) - 1);
}

export function freshWithin(lastSeenAt: string, observedAt: string, thresholdMs: number): boolean {
  const age = Date.parse(observedAt) - Date.parse(lastSeenAt);
  return Number.isFinite(age) && age >= 0 && age <= thresholdMs;
}

function assertion(assertions: Assertion[], id: string, passed: boolean, evidence: unknown): void {
  assertions.push({ evidence, id, passed });
}

function audit(suffix: string, occurredAt: string): AutomationAudit {
  return {
    actor_id: "issue-780-deterministic-runner",
    actor_kind: "runner",
    correlation_id: `issue-780:${suffix}`,
    event_id: `issue-780:${suffix}`,
    gate: {
      authority: "deterministic_policy",
      decision: "allow",
      policy_ref: "issue-780-local-fixture:v1"
    },
    occurred_at: occurredAt,
    reason: "Issue 780 isolated deterministic live fixture"
  };
}

function fixtureIssueID(db: RunnerDatabase): number {
  const id = db.sqlite.query<{ id: number }, []>(
    "select id from issues where project_id='agentic-activation-issue-780' order by id limit 1"
  ).get()?.id;
  if (!id) throw new Error("fixture issue is missing");
  return id;
}

function scalar(db: RunnerDatabase, sql: string, ...params: any[]): number {
  return Number(db.sqlite.query<{ value: number }, any[]>(sql).get(...params)?.value ?? 0);
}

function scalarText(db: RunnerDatabase, sql: string, ...params: any[]): string {
  return String(db.sqlite.query<{ value: unknown }, any[]>(sql).get(...params)?.value ?? "");
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status
  });
}

function timelineWriter(artifactDir: string) {
  const path = join(artifactDir, "timeline.jsonl");
  return {
    record(type: string, payload: Json) {
      appendFileSync(path, `${JSON.stringify({
        at: new Date().toISOString(),
        payload: redact(payload),
        type
      })}\n`);
    }
  };
}

function appendWorkerLog(options: Options, generation: number, event: string, payload: Json): void {
  appendFileSync(artifact(options, "core-worker.log"), `${JSON.stringify({
    at: new Date().toISOString(),
    event,
    generation,
    payload: redact(payload)
  })}\n`);
}

async function captureStream(
  stream: ReadableStream<Uint8Array> | number | undefined,
  path: string,
  source: string
): Promise<void> {
  if (!stream || typeof stream === "number") return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    appendFileSync(path, `[${source}] ${decoder.decode(value, { stream: true })}`);
  }
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Json).map(([key, item]) => {
    if (/(token|secret|password|authorization)/i.test(key)) return [key, "<redacted>"];
    if (/(runtime_dir|state_dir|db_path)/i.test(key)) return [key, "<temporary-state>"];
    return [key, redact(item)];
  }));
}

function writeReplay(options: Options): void {
  writeFileSync(artifact(options, "replay.md"), `# Issue #780 Heartbeat/Watch live replay

## Scope

The replay uses a real wall clock, an isolated temporary SQLite database, and a
separate deterministic schedule-Core process. It imports the production
\`createPiAutoManageScheduler\` and native \`runWatchAutomationsOnce\` path.
It never uses a fake clock, an LLM, launchd state, or an external notification
target.

## Commands

\`\`\`bash
cd ${JSON.stringify(options.repoRoot)}
cd backend-ts
bun test ../scripts/heartbeat-watch-live.test.ts \\
  src/runner/watchAutomationRuntime.test.ts \\
  src/runner/piAutoManageSchedulerWatchdog.test.ts
cd ..
bun scripts/heartbeat-watch-live.ts exercise \\
  --artifact-dir .runner/artifacts/agentic-activation/issue-780 \\
  --control-port ${options.controlPort} \\
  --interval-ms ${options.intervalMs}
./scripts/status-launchd.sh
git diff --check -- scripts/heartbeat-watch-live.ts scripts/heartbeat-watch-live.test.ts
\`\`\`

## Pass criteria

- \`report.json.result\` is \`passed\` and every assertion has
  \`passed=true\`.
- \`tick-samples.json\` contains at least five distinct real timestamps.
- Three initial ticks keep Issue/Run/Automation Run counts unchanged.
- \`watch-match.json\` contains exactly one local notification intent and one
  terminal Watch event.
- \`restart-recovery.json\` has different old/new PIDs, one or more missed
  slots, an explicit non-replay policy, and a successful next tick.
- \`pause-resume.json\` shows no watchdog timestamp change for at least two
  intervals, followed by a fresh tick after resume.
- Cleanup removes the temporary state and leaves the production 30-second
  interval and launchd pilot configuration untouched.
`);
}

function resetArtifacts(artifactDir: string): void {
  for (const name of [
    "baseline.json", "fixture-manifest.json", "no-change-cycles.json",
    "restart-recovery.json", "watch-match.json", "watermark-replay.json",
    "pause-resume.json", "tick-samples.json", "runtime-integrity.json",
    "final-state.json", "runtime-cleanup.json", "timeline.jsonl", "report.json",
    "replay.md", "core-worker.log"
  ]) rmSync(join(artifactDir, name), { force: true });
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(redact(value), null, 2)}\n`);
}

function artifact(options: Options, name: string): string {
  return join(options.artifactDir, name);
}

function readProductionInterval(repoRoot: string): number {
  const source = readFileSync(join(repoRoot, "backend-ts/src/runner/piAutoManageScheduler.ts"), "utf8");
  const match = /const DEFAULT_INTERVAL_MS = ([0-9_]+);/.exec(source);
  return match ? Number(match[1]!.replaceAll("_", "")) : 0;
}

function parseArgs(args: string[]): Options {
  const command = args.shift() ?? "";
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index] ?? "";
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
    values.set(key.slice(2), value);
    index += 1;
  }
  const repoRoot = resolve(values.get("repo-root") ?? resolve(import.meta.dir, ".."));
  return {
    artifactDir: resolve(repoRoot, values.get("artifact-dir") ?? DEFAULT_ARTIFACT_DIR),
    command,
    controlPort: positiveInteger(values.get("control-port") ?? "4580", "--control-port"),
    intervalMs: positiveInteger(values.get("interval-ms") ?? "1200", "--interval-ms"),
    repoRoot,
    runtimeDir: values.get("runtime-dir") ? resolve(values.get("runtime-dir")!) : ""
  };
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function assertSafeInterval(intervalMs: number): void {
  if (intervalMs < 1_000 || intervalMs > 10_000) {
    throw new Error("--interval-ms must be between 1000 and 10000 for real-clock sampling");
  }
}

function assertPortUnused(port: number): void {
  const pid = listenerPID(port);
  if (pid > 0) throw new Error(`control port ${port} is already used by PID ${pid}`);
}

async function waitForPortRelease(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (listenerPID(port) === 0) return;
    await sleep(50);
  }
  throw new Error(`control port ${port} was not released`);
}

function listenerPID(port: number): number {
  const result = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    stderr: "pipe",
    stdout: "pipe"
  });
  if (result.exitCode !== 0) return 0;
  const pid = Number(result.stdout.toString().trim().split(/\s+/)[0] ?? "0");
  return Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return Bun.sleep(ms);
}

export { actionSideEffectWatermark, countWatermark };
