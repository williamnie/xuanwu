#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AUTOMATION_STATUSES } from "../frontend/src/pages/automationsModel.js";
import {
  createFixture,
  resetFixture,
  type FixtureManifest
} from "./agentic-activation-fixture.ts";

const CONTRACT = "xw.agentic-activation.automation-standing-order.v1";
const PROJECT_ID = "codex-issue-runner";
const DEFAULT_ARTIFACT_DIR = ".runner/artifacts/agentic-activation/issue-778";
const TERMINAL_RUN_STATUSES = new Set(["failed", "skipped", "succeeded"]);

type Json = Record<string, any>;
type ApiClient = {
  request(path: string, init?: RequestInit): Promise<{ body: any; status: number }>;
};

type Options = {
  addr: string;
  artifactDir: string;
  backendPort: number;
  command: string;
  db: string;
  frontendPort: number;
  repoRoot: string;
  runtimeDir: string;
  token: string;
  tokenFile: string;
};

type TimelineWriter = {
  path: string;
  record(kind: string, detail: Json): void;
};

type LiveContext = {
  automationID: string;
  client: ApiClient;
  db: Database;
  options: Options;
  runtime: IsolatedRuntime;
  timeline: TimelineWriter;
};

type IsolatedRuntime = {
  addr: string;
  backendPID: number;
  child: ReturnType<typeof Bun.spawn>;
  db: string;
  frontendAddr: string;
  logPath: string;
  options: Options;
  stateDir: string;
};

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command !== "exercise") throw new Error(`unknown command: ${options.command}`);
  mkdirSync(options.artifactDir, { recursive: true });
  resetArtifactDirectory(options.artifactDir);
  const runtime = await startIsolatedRuntime(options);
  try {
    options.addr = runtime.addr;
    options.db = runtime.db;
    await ensurePilotProject(httpClient(runtime.addr, ""), options.repoRoot);
    const report = await exercise(options, runtime);
    console.log(JSON.stringify(report, null, 2));
    if (report.result !== "passed") process.exitCode = 1;
  } finally {
    await stopIsolatedRuntime(runtime);
    writeJson(join(options.artifactDir, "runtime-cleanup.json"), {
      backend_port: options.backendPort,
      frontend_port: options.frontendPort,
      live_launchd_touched: false,
      outcome: "isolated dev runtime stopped",
      runtime_scope: "temporary non-live state"
    });
    if (!options.runtimeDir) rmSync(runtime.stateDir, { force: true, recursive: true });
  }
}

export async function exercise(options: Options, runtime: IsolatedRuntime): Promise<Json> {
  mkdirSync(options.artifactDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const timeline = timelineWriter(join(options.artifactDir, "timeline.jsonl"));
  const client = httpClient(options.addr, token(options));
  const db = new Database(options.db, { readonly: true, strict: true });
  db.run("pragma busy_timeout=5000");
  const runKey = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const automationID = `automation:agent-02-standing-order-${runKey}`;
  const context: LiveContext = { automationID, client, db, options, runtime, timeline };
  let fixture: FixtureManifest | null = null;
  let originalSettings: Json | null = null;
  let rollback: Json | null = null;
  const assertions: Json[] = [];
  const failures: string[] = [];

  timeline.record("exercise.started", {
    automation_id: automationID,
    contract: CONTRACT,
    issue_id: 778,
    project_id: PROJECT_ID
  });

  try {
    const baseline = collectBaseline(db, automationID);
    writeJson(join(options.artifactDir, "baseline.json"), baseline);
    assertResult(assertions, "dependency_fixture_contract_available",
      typeof createFixture === "function" && typeof resetFixture === "function",
      "scripts/agentic-activation-fixture.ts exports create/reset");
    assertResult(assertions, "target_primary_only",
      baseline.authority.target_tables.every(Boolean)
        && baseline.pilot.definition_count === 0
        && baseline.pilot.run_count === 0,
      baseline.authority);
    assertResult(assertions, "supervisor_binding_present",
      baseline.project.managed === 1,
      baseline.project);

    originalSettings = await apiBody(client, `/api/projects/${PROJECT_ID}/pi-settings`);
    timeline.record("fixture.isolation_policy_applied", {
      actor: "frontend:user",
      correlation: `issue-778:${runKey}:binding`,
      outcome: "existing PI binding retained",
      permission: "authenticated local API",
      reason: "automatic takeover is a single project binding; no per-cycle mode mutation"
    });

    fixture = await createFixture(client, 778_001, join(options.artifactDir, "fixture-state"));
    writeJson(join(options.artifactDir, "fixture-manifest.json"), fixture);
    timeline.record("fixture.created", {
      fixture_key: fixture.fixture_key,
      input_issue_ids: fixture.issue_ids,
      outcome: "three isolated triage inputs created",
      source_contract: fixture.contract
    });
    await signalFixture(context, fixture.issue_ids.success, "signal-1", runKey);

    const created = await expectApi(client, "/api/automations", {
      body: JSON.stringify({
        id: automationID,
        idempotency_namespace: `${automationID}:fixture`,
        mode: "propose",
        name: `AGENT-02 Standing Order ${runKey}`,
        permission_policy_ref: `project-policy:${PROJECT_ID}:issue-778-local-fixture`,
        project_id: PROJECT_ID,
        status: "paused",
        trigger: { type: "continuous", config: { poll_interval_seconds: 3600 } },
        workflow_ref: "workflow:investigate@1"
      }),
      method: "POST"
    }, 201);
    let automation = created.automation;
    const pausedCreated = statusSnapshot(created, "created_paused");
    automation = (await setAutomationStatus(context, automation, "active", "activate pilot")).automation;
    const active = await automationDetail(context);
    writeJson(join(options.artifactDir, "status-active.json"), statusSnapshot(active, "active"));

    // A fresh isolated scheduler ticks every 30s. Keep the slot near enough for
    // one cycle while retaining the scheduler's 60s deterministic misfire grace.
    const firstSlot = new Date(Date.now() + 20_000).toISOString();
    automation = (await updateNextRun(context, automation, firstSlot, "signal-1")).automation;
    const firstRun = await waitForRunCount(context, 1, 90_000);
    const firstSnapshot = executionSnapshot(db, automationID);
    writeJson(join(options.artifactDir, "first-signal.json"), firstSnapshot);
    assertResult(assertions, "first_signal_exactly_once",
      firstSnapshot.runs.length === 1
        && firstSnapshot.links.length === 1
        && firstSnapshot.side_effects.evidence_count === 1
        && firstSnapshot.side_effects.handoff_count === 1,
      firstSnapshot.counts);
    assertResult(assertions, "first_signal_terminal_success",
      firstRun.status === "succeeded" && validRunEventOrder(firstSnapshot.run_events, firstRun.run_id),
      { run: firstRun, event_types: eventTypes(firstSnapshot.run_events, firstRun.run_id) });
    assertResult(assertions, "first_signal_uses_777_fixture",
      snapshotContainsFixture(firstSnapshot, fixture.issue_ids.success),
      { fixture_issue_id: fixture.issue_ids.success, links: firstSnapshot.links });

    const replayBefore = sideEffectWatermark(firstSnapshot);
    automation = (await updateNextRun(context, automation, firstSlot, "signal-1-replay")).automation;
    await sleep(35_000);
    const replaySnapshot = executionSnapshot(db, automationID);
    writeJson(join(options.artifactDir, "replay-signal.json"), replaySnapshot);
    assertResult(assertions, "same_signal_is_deduplicated",
      replaySnapshot.runs.length === 1 && equalWatermark(replayBefore, sideEffectWatermark(replaySnapshot)),
      {
        idempotency_key: firstRun.idempotency_key,
        replay_watermark: sideEffectWatermark(replaySnapshot),
        run_count: replaySnapshot.runs.length
      });

    automation = (await setAutomationStatus(context, automation, "paused", "pause before signal-2")).automation;
    const paused = await automationDetail(context);
    writeJson(join(options.artifactDir, "status-paused.json"), statusSnapshot(paused, "paused"));
    await signalFixture(context, fixture.issue_ids.success, "signal-2", runKey);
    const secondSlot = distinctSlot(firstSlot);
    automation = (await updateNextRun(context, automation, secondSlot, "signal-2-while-paused")).automation;
    await sleep(35_000);
    const whilePaused = executionSnapshot(db, automationID);
    assertResult(assertions, "paused_signal_does_not_execute",
      whilePaused.runs.length === 1 && equalWatermark(replayBefore, sideEffectWatermark(whilePaused)),
      sideEffectWatermark(whilePaused));

    automation = (await setAutomationStatus(context, automation, "active", "resume signal-2")).automation;
    const secondRun = await waitForRunCount(context, 2, 90_000);
    const resumed = executionSnapshot(db, automationID);
    writeJson(join(options.artifactDir, "pause-resume.json"), {
      paused: statusSnapshot(paused, "paused"),
      resumed,
      second_run: secondRun
    });
    assertResult(assertions, "resume_executes_held_signal_once",
      resumed.runs.length === 2
        && resumed.links.length === 2
        && resumed.side_effects.evidence_count === 2
        && resumed.side_effects.handoff_count === 2
        && secondRun.status === "succeeded",
      resumed.counts);

    await signalFixture(context, fixture.issue_ids.success, "signal-3-restart", runKey);
    const restart = await queueStopAndRestartCore(context, automation.revision, resumed.runs.map((run: Json) => run.run_id));
    const restartedRun = await waitForRunCount(context, 3, 90_000);
    const afterRestart = executionSnapshot(db, automationID);
    const restartSnapshot = {
      ...restart,
      after_restart: afterRestart,
      restarted_run: restartedRun
    };
    writeJson(join(options.artifactDir, "restart-recovery.json"), restartSnapshot);
    assertResult(assertions, "restart_pending_or_lease_recovered",
      ["queued", "running"].includes(restart.pre_restart.status)
        && restartedRun.status === "succeeded"
        && afterRestart.runs.length === 3,
      {
        pre_restart: restart.pre_restart,
        restarted_run: restartedRun,
        old_pid: restart.old_pid,
        new_pid: restart.new_pid
      });
    assertResult(assertions, "restart_has_no_duplicate_side_effect",
      afterRestart.links.length === 3
        && afterRestart.side_effects.evidence_count === 3
        && afterRestart.side_effects.handoff_count === 3,
      afterRestart.counts);

    assertResult(assertions, "run_event_order_and_idempotency",
      afterRestart.runs.every((run: Json) => run.idempotency_key && validRunEventOrder(afterRestart.run_events, run.run_id)),
      afterRestart.runs.map((run: Json) => ({
        event_types: eventTypes(afterRestart.run_events, run.run_id),
        idempotency_key: run.idempotency_key,
        run_id: run.run_id
      })));

    const statusTruth = {
      active,
      authority: active.authority,
      paused,
      paused_created: pausedCreated,
      ui_model: {
        source: "frontend/src/pages/automationsModel.js",
        statuses: AUTOMATION_STATUSES
      }
    };
    writeJson(join(options.artifactDir, "ui-api-truth-pre-rollback.json"), statusTruth);
    assertResult(assertions, "api_uses_target_primary_live_truth",
      active.authority?.definition === "automation_definitions"
        && active.authority?.dual_read === "none"
        && active.authority?.dual_write === "none"
        && active.automation?.status === "active"
        && paused.automation?.status === "paused"
        && ["active", "paused", "archived"].every((status) => AUTOMATION_STATUSES.includes(status)),
      {
        authority: active.authority,
        active: active.automation?.status,
        paused: paused.automation?.status
      });

    rollback = await rollbackPilot(context, automation, fixture, originalSettings);
    fixture = null;
    originalSettings = null;
    const archived = await automationDetail(context);
    rollback.archived_api = statusSnapshot(archived, "archived");
    rollback.after = executionSnapshot(db, automationID);
    rollback.legacy_counts_after = legacyCounts(db);
    writeJson(join(options.artifactDir, "rollback.json"), rollback);
    assertResult(assertions, "rollback_archives_definition",
      archived.automation?.status === "archived", rollback.archived_api);
    assertResult(assertions, "rollback_has_no_hanging_lease",
      rollback.after.counts.open_leases === 0 && rollback.after.counts.open_runs === 0,
      rollback.after.counts);
    assertResult(assertions, "fixture_reset_without_manual_database_repair",
      rollback.fixture_reset?.residual_issue_count === 0
        && rollback.fixture_reset?.residual_run_count === 0,
      rollback.fixture_reset);
    assertResult(assertions, "legacy_automation_state_unchanged",
      equalWatermark(baseline.authority.legacy_counts, rollback.legacy_counts_after),
      {
        after: rollback.legacy_counts_after,
        before: baseline.authority.legacy_counts
      });

    const actionAudit = collectActionAudit(db, automationID);
    writeJson(join(options.artifactDir, "action-audit.json"), actionAudit);
    assertResult(assertions, "all_actions_are_audited",
      actionAudit.actions.length > 0 && actionAudit.actions.every(completeActionAudit),
      { action_count: actionAudit.actions.length, incomplete: actionAudit.actions.filter((item: Json) => !completeActionAudit(item)) });

    const service = await serviceSnapshot(options, db);
    writeJson(join(options.artifactDir, "service-after.json"), service);
    assertResult(assertions, "service_and_db_healthy",
      service.web_health === "ok"
        && service.core_health === "ok"
        && service.core_process.running
        && service.db_quick_check === "ok",
      service);

    const archivedTruth = {
      api: statusSnapshot(archived, "archived"),
      authority: archived.authority,
      status_history: ["paused", "active", "paused", "active", "paused", "archived"],
      ui_model_statuses: AUTOMATION_STATUSES
    };
    writeJson(join(options.artifactDir, "ui-api-truth.json"), archivedTruth);
  } catch (error) {
    failures.push(safeError(error));
    timeline.record("exercise.failed", { error: safeError(error) });
  } finally {
    if (fixture || originalSettings) {
      try {
        rollback = await emergencyRollback(context, fixture, originalSettings);
        writeJson(join(options.artifactDir, "rollback-emergency.json"), rollback);
        timeline.record("rollback.emergency_completed", rollback);
      } catch (error) {
        failures.push(`emergency rollback failed: ${safeError(error)}`);
      }
    }
    db.close();
  }

  for (const assertion of assertions) {
    if (!assertion.passed) failures.push(`assertion failed: ${assertion.id}`);
  }
  const report = {
    artifact_refs: artifactRefs(options.artifactDir),
    assertions,
    automation_id: automationID,
    contract: "xw.agentic-activation.issue-report.v1",
    ended_at: new Date().toISOString(),
    failure_reasons: [...new Set(failures)],
    issue_id: 778,
    result: failures.length === 0 ? "passed" : "failed",
    started_at: startedAt
  };
  writeJson(join(options.artifactDir, "report.json"), report);
  timeline.record("exercise.completed", {
    assertion_count: assertions.length,
    failure_count: report.failure_reasons.length,
    result: report.result
  });
  return report;
}

async function rollbackPilot(
  context: LiveContext,
  automation: Json,
  fixture: FixtureManifest,
  originalSettings: Json
): Promise<Json> {
  let current = (await automationDetail(context)).automation;
  if (current.status === "active") {
    current = (await setAutomationStatus(context, current, "paused", "rollback pause")).automation;
  }
  if (current.status !== "archived") {
    current = (await setAutomationStatus(context, current, "archived", "rollback archive")).automation;
  }
  const restored = await apiBody(context.client, `/api/projects/${PROJECT_ID}/pi-settings`);
  const fixtureReset = await resetFixture(context.client, fixture);
  context.timeline.record("rollback.completed", {
    automation_status: current.status,
    fixture_reset: fixtureReset,
    outcome: "archived with no manual DB mutation",
    project_binding_unchanged: JSON.stringify(restored) === JSON.stringify(originalSettings)
  });
  return {
    automation_status: current.status,
    fixture_reset: fixtureReset,
    project_settings_restored: restored
  };
}

async function emergencyRollback(
  context: LiveContext,
  fixture: FixtureManifest | null,
  originalSettings: Json | null
): Promise<Json> {
  await ensureIsolatedRuntimeRunning(context.runtime);
  const result: Json = {};
  try {
    const detail = await automationDetail(context);
    let current = detail.automation;
    if (current.status === "active") {
      current = (await setAutomationStatus(context, current, "paused", "emergency rollback pause")).automation;
    }
    if (current.status !== "archived") {
      current = (await setAutomationStatus(context, current, "archived", "emergency rollback archive")).automation;
    }
    result.automation_status = current.status;
  } catch (error) {
    result.automation_error = safeError(error);
  }
  if (originalSettings) result.project_settings_unchanged = originalSettings;
  if (fixture) {
    try {
      result.fixture_reset = await resetFixture(context.client, fixture);
    } catch (error) {
      result.fixture_reset_error = safeError(error);
    }
  }
  return result;
}

async function signalFixture(context: LiveContext, issueID: number, signal: string, runKey: string): Promise<void> {
  const response = await expectApi(context.client, `/api/issues/${issueID}`, {
    body: JSON.stringify({
      description: [
        `# AGENT-02 local fixture signal`,
        `source=agentic-activation:issue-777`,
        `run_key=${runKey}`,
        `signal=${signal}`,
        `expected_action=local proposal only`,
        `external_writes=forbidden`
      ].join("\n"),
      status: "triage"
    }),
    method: "PATCH"
  }, 200);
  context.timeline.record("signal.accepted", {
    actor: "frontend:user",
    correlation: `issue-778:${runKey}:${signal}`,
    input: { fixture_issue_id: issueID, source: "agentic-activation:issue-777" },
    outcome: response.status,
    permission: "authenticated local fixture mutation",
    reason: `emit ${signal}`
  });
}

async function setAutomationStatus(
  context: LiveContext,
  automation: Json,
  status: "active" | "archived" | "paused",
  reason: string
): Promise<Json> {
  const response = await expectApi(context.client, `/api/automations/${encodeURIComponent(context.automationID)}/status`, {
    body: JSON.stringify({ expected_revision: automation.revision, status }),
    method: "POST"
  }, 200);
  context.timeline.record("automation.status_changed", {
    actor: "frontend:user",
    automation_id: context.automationID,
    correlation: `automation-ui:${context.automationID}`,
    outcome: response.automation.status,
    permission: "human_approval:allow",
    reason
  });
  return response;
}

async function updateNextRun(
  context: LiveContext,
  automation: Json,
  nextRunAt: string,
  signal: string
): Promise<Json> {
  const response = await expectApi(context.client, `/api/automations/${encodeURIComponent(context.automationID)}`, {
    body: JSON.stringify({ expected_revision: automation.revision, next_run_at: nextRunAt }),
    method: "PATCH"
  }, 200);
  context.timeline.record("automation.signal_scheduled", {
    actor: "frontend:user",
    correlation: `issue-778:${signal}`,
    idempotency_slot: nextRunAt,
    outcome: "definition next_run_at persisted",
    permission: "human_approval:allow",
    reason: signal
  });
  return response;
}

async function queueStopAndRestartCore(
  context: LiveContext,
  expectedRevision: number,
  existingRunIDs: string[]
): Promise<Json> {
  const oldPID = context.runtime.backendPID;
  if (oldPID < 1) throw new Error("Core PID is unavailable before restart test");
  context.timeline.record("restart.signal_queued", {
    actor: "frontend:user",
    correlation: `issue-778:restart:${context.automationID}`,
    outcome: "run-now request queued in isolated dev Core",
    permission: "human_approval:allow",
    reason: "create a durable pending/lease state before Core restart"
  });

  const requestResult = await expectApi(
    context.client,
    `/api/automations/${encodeURIComponent(context.automationID)}/run-now`,
    {
    body: JSON.stringify({ expected_revision: expectedRevision }),
      method: "POST"
    },
    202
  );

  // Block only the isolated dev Core's event loop after the durable queue write.
  // This removes the race with the 30s scheduler tick without adding a product
  // hook or touching the launchd-managed live service.
  const block = context.client.request("/api/system/test/block").catch((error) => ({
    body: { request_error: safeError(error) },
    status: 0
  }));
  await sleep(250);
  const preRestart = await waitForNewRun(context, existingRunIDs, 60_000);
  context.timeline.record("core.stopped", {
    outcome: preRestart.status,
    pid: oldPID,
    run_id: preRestart.run_id,
    runtime_scope: "isolated ./dev.sh",
    state: {
      lease_expires_at: preRestart.lease_expires_at,
      lease_present: Boolean(preRestart.lease_token),
      status: preRestart.status
    }
  });
  await restartIsolatedRuntime(context.runtime);
  await block;
  const newPID = context.runtime.backendPID;
  context.timeline.record("core.restarted", {
    new_pid: newPID,
    old_pid: oldPID,
    outcome: "isolated dev Core process replaced with persisted SQLite state",
    runtime_scope: "isolated ./dev.sh"
  });
  return {
    new_pid: newPID,
    old_pid: oldPID,
    pre_restart: redactLease(preRestart),
    run_now_response: requestResult,
    runtime_scope: "isolated ./dev.sh; launchd untouched"
  };
}

async function waitForNewRun(context: LiveContext, existingRunIDs: string[], timeoutMs: number): Promise<Json> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = context.db.query<Json, [string]>(`
      select * from automation_runs where automation_id=?
      order by created_at desc, run_id desc limit 1
    `).get(context.automationID);
    if (run && !existingRunIDs.includes(String(run.run_id)) && ["queued", "running"].includes(String(run.status))) {
      return run;
    }
    await sleep(50);
  }
  throw new Error("run-now did not persist a pending/lease state before timeout");
}

async function waitForRunCount(context: LiveContext, count: number, timeoutMs: number): Promise<Json> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = context.db.query<Json, [string]>(`
      select * from automation_runs where automation_id=?
      order by created_at asc, run_id asc
    `).all(context.automationID);
    if (runs.length === count && runs.every((run) => TERMINAL_RUN_STATUSES.has(String(run.status)))) {
      const latest = runs.at(-1)!;
      if (latest.status === "failed") throw new Error(`automation run failed: ${latest.summary_json}`);
      return mapRun(latest);
    }
    if (runs.length > count) throw new Error(`expected ${count} Automation Runs, found ${runs.length}`);
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${count} terminal Automation Runs`);
}

async function automationDetail(context: LiveContext): Promise<Json> {
  return apiBody(context.client, `/api/automations/${encodeURIComponent(context.automationID)}`);
}

function collectBaseline(db: Database, automationID: string): Json {
  return {
    authority: {
      legacy_counts: legacyCounts(db),
      legacy_tables: Object.fromEntries(
        ["cron_tasks", "pi_automations", "pi_delegations"].map((name) => [name, tableExists(db, name)])
      ),
      target_tables: [
        "automation_definitions",
        "automation_trigger_configs",
        "automation_runs",
        "automation_events",
        "automation_run_events"
      ].map((name) => tableExists(db, name))
    },
    db_quick_check: scalarText(db, "pragma quick_check"),
    pilot: {
      definition_count: scalarNumber(db, "select count(*) value from automation_definitions where id=?", automationID),
      run_count: scalarNumber(db, "select count(*) value from automation_runs where automation_id=?", automationID)
    },
    project: db.query<Json, [string]>(`
      select 1 managed from project_pi_settings where project_id=?
    `).get(PROJECT_ID) ?? { managed: 0 }
  };
}

function executionSnapshot(db: Database, automationID: string): Json {
  const definition = db.query<Json, [string]>("select * from automation_definitions where id=?").get(automationID);
  const runs = db.query<Json, [string]>(`
    select * from automation_runs where automation_id=? order by created_at asc, run_id asc
  `).all(automationID).map(mapRun);
  const runEvents = db.query<Json, [string]>(`
    select rowid sequence, * from automation_run_events where automation_id=? order by rowid asc
  `).all(automationID);
  const links = db.query<Json, [string]>(`
    select * from automation_execution_links where automation_id=? order by created_at asc, automation_run_id asc
  `).all(automationID);
  const issueIDs = links.map((link) => Number(link.issue_id)).filter(Number.isSafeInteger);
  const evidenceCount = issueIDs.length === 0 ? 0 : scalarNumber(
    db,
    `select count(*) value from issue_events where type='evidence.recorded.v1'
      and issue_id in (${issueIDs.map(() => "?").join(",")})`,
    ...issueIDs
  );
  const handoffCount = issueIDs.length === 0 ? 0 : scalarNumber(
    db,
    `select count(*) value from issue_events where type='handoff.prepared.v1'
      and issue_id in (${issueIDs.map(() => "?").join(",")})`,
    ...issueIDs
  );
  const contexts = issueIDs.length === 0 ? [] : db.query<Json, any[]>(`
    select issue_id, json_extract(payload, '$.evidence.decisive_output.facts.execution_context_json') context_json
    from issue_events where type='evidence.recorded.v1'
      and issue_id in (${issueIDs.map(() => "?").join(",")})
    order by id
  `).all(...issueIDs).map((row) => ({
    issue_id: row.issue_id,
    context: parseJson(row.context_json)
  }));
  return {
    contexts,
    counts: {
      evidence: evidenceCount,
      handoffs: handoffCount,
      links: links.length,
      open_leases: runs.filter((run) => run.lease_token || run.lease_expires_at).length,
      open_runs: runs.filter((run) => ["queued", "running"].includes(run.status)).length,
      run_events: runEvents.length,
      runs: runs.length
    },
    definition,
    links,
    run_events: runEvents,
    runs,
    side_effects: {
      evidence_count: evidenceCount,
      handoff_count: handoffCount,
      linked_work_count: links.length
    }
  };
}

function collectActionAudit(db: Database, automationID: string): Json {
  const definition = db.query<Json, [string]>("select permission_policy_ref from automation_definitions where id=?")
    .get(automationID);
  const definitionActions = db.query<Json, [string]>(`
    select event_id id, event_type action, actor_id actor, reason,
      correlation_id correlation, gate_authority || ':' || gate_decision || ':' || gate_policy_ref permission,
      'persisted' outcome, occurred_at
    from automation_events where automation_id=?
    order by occurred_at, event_id
  `).all(automationID);
  const runActions = db.query<Json, [string]>(`
    select event_id id, event_type action, actor_id actor, detail reason,
      correlation_id correlation, occurred_at,
      case
        when event_type like '%succeeded%' then 'succeeded'
        when event_type like '%skipped%' then 'skipped'
        when event_type like '%failed%' or event_type like '%dead_lettered%' then 'failed'
        when event_type like '%claimed%' then 'claimed'
        when event_type like '%queued%' then 'queued'
        when event_type like '%lease_expired%' then 'recovered'
        else 'persisted'
      end outcome
    from automation_run_events where automation_id=?
    order by occurred_at, event_id
  `).all(automationID).map((item) => ({
    ...item,
    permission: `deterministic_policy:allow:${definition?.permission_policy_ref ?? ""}`
  }));
  return { actions: [...definitionActions, ...runActions].sort(actionOrder) };
}

async function serviceSnapshot(options: Options, db: Database): Promise<Json> {
  const status = await apiBody(httpClient(options.addr, token(options)), "/api/system/status?compact=1");
  return {
    core_health: await health(options.addr),
    core_process: {
      pid: backendPID(options.backendPort),
      role: status.service?.role,
      running: backendPID(options.backendPort) > 0
    },
    db_quick_check: scalarText(db, "pragma quick_check"),
    runtime_scope: "isolated ./dev.sh; live launchd untouched",
    web_health: await frontendHealth(`127.0.0.1:${options.frontendPort}`)
  };
}

function legacyCounts(db: Database): Json {
  return Object.fromEntries(["cron_tasks", "pi_automations", "pi_delegations"].map((name) => [
    name,
    tableExists(db, name) ? scalarNumber(db, `select count(*) value from ${name}`) : null
  ]));
}

async function health(addr: string): Promise<string> {
  const response = await fetch(`http://${addr}/health`, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) return `http-${response.status}`;
  const body = await response.json() as Json;
  return body.status === "ok" ? "ok" : JSON.stringify(body);
}

async function frontendHealth(addr: string): Promise<string> {
  const response = await fetch(`http://${addr}/`, { signal: AbortSignal.timeout(10_000) });
  return response.ok ? "ok" : `http-${response.status}`;
}

function snapshotContainsFixture(snapshot: Json, issueID: number): boolean {
  return snapshot.contexts.some((entry: Json) => (
    Array.isArray(entry.context?.items)
      && entry.context.items.some((item: Json) => Number(item.payload?.issue_id) === issueID)
  ));
}

function validRunEventOrder(events: Json[], runID: string): boolean {
  const types = eventTypes(events, runID);
  const queued = types.indexOf("automation.run_queued.v1");
  const succeeded = types.lastIndexOf("automation.run_succeeded.v1");
  const claims = types
    .map((type, index) => type === "automation.run_claimed.v1" ? index : -1)
    .filter((index) => index >= 0);
  const expiredLeases = types
    .map((type, index) => type === "automation.run_lease_expired.v1" ? index : -1)
    .filter((index) => index >= 0);
  return queued >= 0
    && claims.length >= 1
    && succeeded > claims.at(-1)!
    && claims[0]! > queued
    && expiredLeases.every((expired) => claims.some((claim) => claim > expired && claim < succeeded))
    && types.filter((type) => type === "automation.run_succeeded.v1").length === 1;
}

function eventTypes(events: Json[], runID: string): string[] {
  return events.filter((event) => event.run_id === runID).map((event) => String(event.event_type));
}

function sideEffectWatermark(snapshot: Json): Json {
  return {
    evidence_count: snapshot.side_effects.evidence_count,
    handoff_count: snapshot.side_effects.handoff_count,
    linked_work_count: snapshot.side_effects.linked_work_count,
    run_event_count: snapshot.run_events.length,
    run_count: snapshot.runs.length
  };
}

function equalWatermark(left: Json, right: Json): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function completeActionAudit(action: Json): boolean {
  return ["actor", "reason", "correlation", "permission", "outcome"]
    .every((field) => typeof action[field] === "string" && action[field].trim() !== "");
}

function actionOrder(left: Json, right: Json): number {
  return String(left.occurred_at).localeCompare(String(right.occurred_at))
    || String(left.id).localeCompare(String(right.id));
}

function statusSnapshot(detail: Json, observedAs: string): Json {
  const automation = detail.automation ?? detail;
  return {
    authority: detail.authority,
    automation_id: automation.id,
    observed_as: observedAs,
    observed_at: new Date().toISOString(),
    revision: automation.revision,
    status: automation.status
  };
}

function mapRun(run: Json): Json {
  return {
    ...run,
    lease_token: run.lease_token ? "[redacted-present]" : "",
    summary: parseJson(run.summary_json)
  };
}

function redactLease(run: Json): Json {
  return {
    ...mapRun(run),
    lease_token: run.lease_token ? "[redacted-present]" : ""
  };
}

function parseJson(value: unknown): unknown {
  try {
    return typeof value === "string" && value !== "" ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function distinctSlot(previous: string): string {
  return new Date(Math.max(Date.now() + 1_000, Date.parse(previous) + 1_000)).toISOString();
}

function assertResult(assertions: Json[], id: string, passed: boolean, evidence: unknown): void {
  assertions.push({ evidence, id, passed });
}

function timelineWriter(path: string): TimelineWriter {
  writeFileSync(path, "");
  return {
    path,
    record(kind: string, detail: Json) {
      appendFileSync(path, `${JSON.stringify({
        at: new Date().toISOString(),
        detail: redact(detail),
        kind
      })}\n`);
    }
  };
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Json).map(([key, item]) => [
    key,
    /token|secret|password/i.test(key) ? (item ? "[redacted]" : item) : redact(item)
  ]));
}

function resetArtifactDirectory(path: string): void {
  for (const name of [
    "action-audit.json",
    "baseline.json",
    "first-signal.json",
    "fixture-manifest.json",
    "pause-resume.json",
    "replay-signal.json",
    "report.json",
    "restart-recovery.json",
    "rollback-emergency.json",
    "rollback.json",
    "runtime-cleanup.json",
    "service-after.json",
    "status-active.json",
    "status-paused.json",
    "timeline.jsonl",
    "ui-api-truth-pre-rollback.json",
    "ui-api-truth.json",
    "dev-runtime.log"
  ]) {
    rmSync(join(path, name), { force: true, recursive: true });
  }
  rmSync(join(path, "fixture-state"), { force: true, recursive: true });
}

function artifactRefs(path: string): string[] {
  return [
    "baseline.json",
    "fixture-manifest.json",
    "status-active.json",
    "first-signal.json",
    "replay-signal.json",
    "status-paused.json",
    "pause-resume.json",
    "restart-recovery.json",
    "action-audit.json",
    "rollback.json",
    "runtime-cleanup.json",
    "service-after.json",
    "ui-api-truth.json",
    "dev-runtime.log",
    "timeline.jsonl",
    "replay.md"
  ].filter((name) => ["replay.md", "runtime-cleanup.json"].includes(name) || fileExists(join(path, name)));
}

function fileExists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(redact(value), null, 2)}\n`);
}

function httpClient(addr: string, bearer: string): ApiClient {
  return {
    async request(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      headers.set("content-type", "application/json");
      if (bearer) headers.set("authorization", `Bearer ${bearer}`);
      const signal = init.signal ?? AbortSignal.timeout(120_000);
      const response = await fetch(`http://${addr}${path}`, { ...init, headers, signal });
      const text = await response.text();
      return {
        body: text ? JSON.parse(text) : null,
        status: response.status
      };
    }
  };
}

async function expectApi(client: ApiClient, path: string, init: RequestInit, expectedStatus: number): Promise<Json> {
  const response = await client.request(path, init);
  if (response.status !== expectedStatus) {
    throw new Error(`${init.method ?? "GET"} ${path}: expected ${expectedStatus}, got ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response.body as Json;
}

async function apiBody(client: ApiClient, path: string): Promise<Json> {
  return expectApi(client, path, {}, 200);
}

async function startIsolatedRuntime(options: Options): Promise<IsolatedRuntime> {
  const stateDir = options.runtimeDir || mkdtempSync(join(tmpdir(), "codex-issue-778-dev."));
  mkdirSync(stateDir, { recursive: true });
  const runtime: IsolatedRuntime = {
    addr: `127.0.0.1:${options.backendPort}`,
    backendPID: 0,
    child: undefined as unknown as ReturnType<typeof Bun.spawn>,
    db: join(stateDir, "runner.db"),
    frontendAddr: `127.0.0.1:${options.frontendPort}`,
    logPath: join(options.artifactDir, "dev-runtime.log"),
    options,
    stateDir
  };
  writeFileSync(runtime.logPath, "");
  await spawnDevRuntime(runtime);
  return runtime;
}

async function spawnDevRuntime(runtime: IsolatedRuntime): Promise<void> {
  assertPortUnused(runtime.options.backendPort, "backend");
  assertPortUnused(runtime.options.frontendPort, "frontend");
  const child = Bun.spawn(["./dev.sh"], {
    cwd: runtime.options.repoRoot,
    env: {
      ...Bun.env,
      CODEX_RUNNER_AUTH_TOKEN: "",
      CODEX_RUNNER_AUTH_TOKEN_FILE: join(runtime.stateDir, "auth_token"),
      CODEX_RUNNER_DB: runtime.db,
      CODEX_RUNNER_DEV_ADDR: runtime.addr,
      CODEX_RUNNER_STATE_DIR: runtime.stateDir,
      CODEX_RUNNER_TEST_BLOCK_MS: "30000",
      FRONTEND_HOST: "127.0.0.1",
      FRONTEND_PORT: String(runtime.options.frontendPort)
    },
    stderr: "pipe",
    stdout: "pipe"
  });
  runtime.child = child;
  void captureStream(child.stdout, runtime.logPath, "stdout");
  void captureStream(child.stderr, runtime.logPath, "stderr");
  await waitForRuntimeHealth(runtime);
  runtime.backendPID = backendPID(runtime.options.backendPort);
  if (runtime.backendPID < 1) throw new Error("isolated dev Core PID is unavailable");
}

async function restartIsolatedRuntime(runtime: IsolatedRuntime): Promise<void> {
  const oldPID = runtime.backendPID;
  const oldFrontendPID = backendPID(runtime.options.frontendPort);
  if (oldPID < 1) throw new Error("isolated dev Core PID is unavailable before restart");
  process.kill(oldPID, "SIGKILL");
  // dev.sh waits for both children after either one exits. Signal the owning
  // shell as well so its EXIT trap stops Vite instead of waiting forever.
  runtime.child.kill("SIGTERM");
  if (!await waitForChildExit(runtime.child, 3_000, false)) runtime.child.kill("SIGKILL");
  await killOwnedListener(runtime.options.frontendPort, oldFrontendPID);
  await waitForPortRelease(runtime.options.backendPort, 15_000);
  await waitForPortRelease(runtime.options.frontendPort, 15_000);
  await spawnDevRuntime(runtime);
  if (runtime.backendPID === oldPID) throw new Error(`isolated dev Core PID did not change from ${oldPID}`);
}

async function ensureIsolatedRuntimeRunning(runtime: IsolatedRuntime): Promise<void> {
  try {
    if (await health(runtime.addr) === "ok") return;
  } catch {}
  if (runtime.child.exitCode === null) {
    runtime.child.kill("SIGKILL");
    await waitForChildExit(runtime.child, 5_000);
  }
  await waitForPortRelease(runtime.options.backendPort, 10_000);
  await waitForPortRelease(runtime.options.frontendPort, 10_000);
  await spawnDevRuntime(runtime);
}

async function stopIsolatedRuntime(runtime: IsolatedRuntime): Promise<void> {
  if (!runtime.child) return;
  const ownedBackendPID = backendPID(runtime.options.backendPort);
  const ownedFrontendPID = backendPID(runtime.options.frontendPort);
  if (runtime.child.exitCode === null) {
    runtime.child.kill("SIGTERM");
    if (!await waitForChildExit(runtime.child, 3_000, false)) runtime.child.kill("SIGKILL");
  }
  await killOwnedListener(runtime.options.backendPort, ownedBackendPID);
  await killOwnedListener(runtime.options.frontendPort, ownedFrontendPID);
  await waitForChildExit(runtime.child, 5_000, false);
}

async function waitForRuntimeHealth(runtime: IsolatedRuntime): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (runtime.child.exitCode !== null) {
      throw new Error(`./dev.sh exited before health check (exit ${runtime.child.exitCode}); see ${runtime.logPath}`);
    }
    try {
      const [backend, frontend] = await Promise.all([
        health(runtime.addr),
        frontendHealth(runtime.frontendAddr)
      ]);
      if (backend === "ok" && frontend === "ok") return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`isolated ./dev.sh health timed out; see ${runtime.logPath}`);
}

async function ensurePilotProject(client: ApiClient, repoRoot: string): Promise<void> {
  const existing = await client.request(`/api/projects/${PROJECT_ID}`);
  if (existing.status === 200) return;
  if (existing.status !== 404) {
    throw new Error(`read isolated project returned HTTP ${existing.status}: ${JSON.stringify(existing.body)}`);
  }
  await expectApi(client, "/api/projects", {
    body: JSON.stringify({ auto_run: false, cwd: repoRoot, id: PROJECT_ID }),
    method: "POST"
  }, 201);
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

async function waitForChildExit(
  child: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
  throwOnTimeout = true
): Promise<boolean> {
  if (child.exitCode !== null) return true;
  const outcome = await Promise.race([
    child.exited.then(() => "exited" as const),
    sleep(timeoutMs).then(() => "timeout" as const)
  ]);
  if (outcome === "exited") return true;
  if (throwOnTimeout) throw new Error(`./dev.sh did not exit within ${timeoutMs}ms`);
  return false;
}

function backendPID(port: number): number {
  const result = Bun.spawnSync([
    "lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"
  ], { stderr: "pipe", stdout: "pipe" });
  if (result.exitCode !== 0) return 0;
  const pid = Number(result.stdout.toString().trim().split(/\s+/)[0] ?? "0");
  return Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
}

function assertPortUnused(port: number, label: string): void {
  const pid = backendPID(port);
  if (pid > 0) throw new Error(`isolated ${label} port ${port} is already used by PID ${pid}`);
}

async function waitForPortRelease(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (backendPID(port) === 0) return;
    await sleep(100);
  }
  throw new Error(`port ${port} was not released within ${timeoutMs}ms`);
}

async function killOwnedListener(port: number, expectedPID: number): Promise<void> {
  if (expectedPID < 1) return;
  const currentPID = backendPID(port);
  if (currentPID !== expectedPID) return;
  try {
    process.kill(currentPID, "SIGKILL");
  } catch {}
  await waitForPortRelease(port, 10_000);
}

function tableExists(db: Database, name: string): boolean {
  return Boolean(db.query<{ value: number }, [string]>(
    "select count(*) value from sqlite_master where type='table' and name=?"
  ).get(name)?.value);
}

function scalarNumber(db: Database, sql: string, ...params: any[]): number {
  const row = db.query<{ value: number }, any[]>(sql).get(...params);
  return Number(row?.value ?? 0);
}

function scalarText(db: Database, sql: string, ...params: any[]): string {
  const row = db.query<Record<string, unknown>, any[]>(sql).get(...params);
  return String(row ? Object.values(row)[0] ?? "" : "");
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
  const backendPort = positivePort(values.get("backend-port") ?? "4579", "--backend-port");
  const frontendPort = positivePort(values.get("frontend-port") ?? "4578", "--frontend-port");
  if (backendPort === frontendPort) throw new Error("backend and frontend ports must be distinct");
  return {
    addr: `127.0.0.1:${backendPort}`,
    artifactDir: resolve(values.get("artifact-dir") ?? DEFAULT_ARTIFACT_DIR),
    backendPort,
    command,
    db: "",
    frontendPort,
    repoRoot: resolve(values.get("repo-root") ?? resolve(import.meta.dir, "..")),
    runtimeDir: values.get("runtime-dir") ? resolve(values.get("runtime-dir")!) : "",
    token: values.get("token") ?? "",
    tokenFile: values.get("token-file") ?? ""
  };
}

function token(options: Options): string {
  if (options.token) return options.token.trim();
  if (options.tokenFile) return readFileSync(resolve(options.tokenFile), "utf8").trim();
  return "";
}

function positivePort(value: string, label: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`${label} must be an integer between 1024 and 65535`);
  }
  return port;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return Bun.sleep(ms);
}

export {
  completeActionAudit,
  equalWatermark,
  eventTypes,
  validRunEventOrder
};
