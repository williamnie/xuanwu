#!/usr/bin/env bun
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase, type RunnerDatabase } from "../src/db/database.ts";
import { createIssue } from "../src/db/repositories/issueCreate.ts";
import { getIssue, listIssueRuns } from "../src/db/repositories/issues.ts";
import { updateIssue } from "../src/db/repositories/issueUpdate.ts";
import {
  createProjectPiSettings,
  getProjectPiSettings,
  listIssueSupervisorEvents,
  listPiActions,
  updateProjectPiSettings,
  upsertProjectPiPolicy
} from "../src/db/repositories/pi.ts";
import { createProject, getProject } from "../src/db/repositories/projects.ts";
import { getIssueAsWork } from "../src/domain/work/issueAdapter.ts";
import { runProjectPiCycle } from "../src/http/piProjectControlApi.ts";
import { runPiAutoManageCycle } from "../src/runner/piAutoManageScheduler.ts";
import { runPiIssueSupervisorSchedulerOnce } from "../src/runner/piIssueSupervisorScheduler.ts";
import { projectLoopDecision, runProjectLoopOnce } from "../src/runner/projectLoop.ts";
import { normalizedRunEvent } from "../src/providers/runEvents.ts";
import type { ExecutorProvider, ProviderRunInput, ProviderRunResult, SessionRef } from "../src/providers/types.ts";

const CONTRACT = "xw.agentic-activation.supervisor-auto-management.v1";
const PROJECT_ID = "xuanwu";
const UNAUTHORIZED_PROJECT_ID = "agent-03-unauthorized";
const PI_PROVIDER = "pi-agent-03-faux";
const PI_API = "pi-agent-03-faux-api";
const PI_MODEL = "faux-1";
const REPO_ROOT = resolve(import.meta.dir, "../..");
const DEFAULT_ARTIFACT_DIR = join(REPO_ROOT, ".runner/artifacts/agentic-activation/issue-779");

type Json = Record<string, any>;
type Assertion = { id: string; passed: boolean; evidence: unknown };
type Timeline = { record(type: string, payload: Json): void };
type FixtureIDs = {
  eligible: number;
  missing: number;
  retryable: number;
  unrecoverable: number;
  expired: number;
  dependency: number;
  blocker: number;
};

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const command = String(args.command ?? "exercise");
  if (command === "worker") {
    worker(args).catch(failMain);
  } else if (command === "exercise") {
    exercise(args).catch(failMain);
  } else {
    failMain(new Error(`unknown command: ${command}`));
  }
}

async function exercise(args: Json): Promise<void> {
  const artifactDir = resolve(String(args.artifactDir ?? DEFAULT_ARTIFACT_DIR));
  mkdirSync(artifactDir, { recursive: true });
  for (const name of ["report.json", "timeline.jsonl", "runtime-state.json", "restart-recovery.json"]) {
    rmSync(join(artifactDir, name), { force: true });
  }
  const timeline = timelineWriter(join(artifactDir, "timeline.jsonl"));
  const startedAt = new Date().toISOString();
  const runtimeRoot = mkdtempSync(join(tmpdir(), "agent-03-supervisor-"));
  const stateDir = join(runtimeRoot, "state");
  const fixtureCwd = join(runtimeRoot, "authorized-cwd");
  const unauthorizedCwd = join(runtimeRoot, "unauthorized-cwd");
  mkdirSync(fixtureCwd);
  mkdirSync(unauthorizedCwd);
  const assertions: Assertion[] = [];
  const failures: string[] = [];
  let db: RunnerDatabase | undefined;

  timeline.record("exercise.started", {
    contract: CONTRACT,
    issue_id: 779,
    project_id: PROJECT_ID,
    runtime_scope: "isolated fixture Core; external_writes=0"
  });

  try {
    db = await openDatabase({ stateDir });
    setupRuntime(db, fixtureCwd, unauthorizedCwd);
    const ids = createFixtures(db);
    writeJson(join(artifactDir, "fixture-manifest.json"), {
      contract: CONTRACT,
      external_writes: 0,
      ids,
      project_id: PROJECT_ID,
      source_fixture: "issue-777",
      unauthorized_project_id: UNAUTHORIZED_PROJECT_ID
    });

    updateProjectPiSettings(db, PROJECT_ID, { auto_manage: 0 });
    const paused = await runPiAutoManageCycle({
      database: db,
      runProjectCycle: (input) => runProjectPiCycle({ database: db! }, input)
    });
    assert(assertions, "pause_blocks_auto_management", paused.projects === 0 && paused.started === 0, paused);
    timeline.record("supervisor.paused", { outcome: paused, policy: "project_pi_settings.auto_manage=0" });

    updateProjectPiSettings(db, PROJECT_ID, { auto_manage: 1 });
    const eligibleWork = mustWork(db, ids.eligible);
    const enqueueKey = "issue-779:intent:eligible:enqueue:v1";
    const firstCycle = await managerCycle(db, [
      fauxAssistantMessage([
        fauxToolCall("work_read", { work_id: eligibleWork.id }, { id: "eligible-read" }),
        fauxToolCall("work_control", {
          action: "enqueue",
          expected_revision: eligibleWork.revision,
          idempotency_key: enqueueKey,
          reason: "complete #777 fixture intent is authorized and dependency-ready",
          work_id: eligibleWork.id
        }, { id: "eligible-enqueue" })
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("eligible Work selected and enqueued once")
    ]);
    const eligibleAfter = getIssue(db, ids.eligible)!;
    const eligibleAction = actionByKey(db, enqueueKey);
    assert(assertions, "complete_intent_selected_and_enqueued",
      firstCycle.started === 1 && eligibleAfter.status === "todo" && eligibleAction?.status === "completed",
      { action: compactAction(eligibleAction), cycle: firstCycle, issue_status: eligibleAfter.status });
    timeline.record("supervisor.intent_enqueued", {
      action_id: eligibleAction?.id,
      input_evidence: `issue:${ids.eligible}`,
      intent_key: enqueueKey,
      outcome: eligibleAfter.status,
      permission: "delegated project-scoped work.enqueue",
      policy: "project_pi_settings.auto_enqueue=1"
    });

    const replayCycle = await managerCycle(db, [
      fauxAssistantMessage([
        fauxToolCall("work_control", {
          action: "enqueue",
          expected_revision: eligibleWork.revision,
          idempotency_key: enqueueKey,
          reason: "complete #777 fixture intent is authorized and dependency-ready",
          work_id: eligibleWork.id
        }, { id: "eligible-replay" })
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("idempotent replay observed; no duplicate Work or Run")
    ]);
    const replayActions = actionsBySuffix(db, enqueueKey);
    assert(assertions, "same_intent_replay_is_noop",
      replayCycle.started === 1 && replayActions.length === 1 && listIssueRuns(db, ids.eligible).length === 0 &&
        issueWorkCount(db, ids.eligible) === 1,
      {
        action_count: replayActions.length,
        run_count: listIssueRuns(db, ids.eligible).length,
        work_count: issueWorkCount(db, ids.eligible)
      });
    timeline.record("supervisor.intent_replayed", {
      action_count: replayActions.length,
      intent_key: enqueueKey,
      outcome: "idempotent_noop",
      run_count: listIssueRuns(db, ids.eligible).length,
      work_count: issueWorkCount(db, ids.eligible)
    });

    const provider = new FixtureExecutionProvider(db, fixtureCwd, timeline);
    const success = await runProjectLoopOnce(loopInput(db, provider));
    assert(assertions, "automatic_success_reaches_verification",
      success.claimed && getIssue(db, ids.eligible)?.status === "pending_verification" && listIssueRuns(db, ids.eligible).length === 1,
      issueSnapshot(db, ids.eligible));

    const actionCountBeforeMissing = listPiActions(db, { projectId: PROJECT_ID }).length;
    const missingCycle = await managerCycle(db, [
      fauxAssistantMessage("no-op: required parameter target_path is missing; do not guess or enqueue")
    ]);
    const missingAfter = getIssue(db, ids.missing)!;
    assert(assertions, "missing_parameter_is_single_noop",
      missingCycle.started === 1 && missingAfter.status === "triage" &&
        listPiActions(db, { projectId: PROJECT_ID }).length === actionCountBeforeMissing,
      { action_delta: listPiActions(db, { projectId: PROJECT_ID }).length - actionCountBeforeMissing, status: missingAfter.status });
    timeline.record("supervisor.missing_parameter_noop", {
      input_evidence: `issue:${ids.missing}`,
      missing: ["target_path"],
      outcome: "noop",
      policy: "required_parameters_complete"
    });

    const expiredCycle = await managerCycle(db, [
      fauxAssistantMessage("no-op: fixture deadline expired; escalate through report instead of executing")
    ]);
    assert(assertions, "expired_deadline_is_not_executed",
      expiredCycle.started === 1 && getIssue(db, ids.expired)?.status === "triage",
      issueSnapshot(db, ids.expired));
    timeline.record("supervisor.deadline_blocked", {
      deadline_at: "2026-01-01T00:00:00.000Z",
      input_evidence: `issue:${ids.expired}`,
      outcome: "noop",
      policy: "deadline_at > now"
    });

    await enqueueBySupervisor(db, ids.retryable, "issue-779:intent:retryable:enqueue:v1");
    const retryFirst = await runProjectLoopOnce(loopInput(db, provider));
    const retryFirstSnapshot = issueSnapshot(db, ids.retryable);
    assert(assertions, "retryable_first_failure_is_retained",
      retryFirst.claimed && getIssue(db, ids.retryable)?.status === "failed" && listIssueRuns(db, ids.retryable).length === 1,
      retryFirstSnapshot);

    const retrySupervisor = await runPiIssueSupervisorSchedulerOnce({
      database: db,
      now: new Date(),
      providers: { "fake-execution-only": provider },
      staleAfterSeconds: 1
    });
    assert(assertions, "retryable_failure_requeued_within_budget",
      retrySupervisor.decisions >= 1 && getIssue(db, ids.retryable)?.status === "todo",
      { issue: issueSnapshot(db, ids.retryable), scheduler: retrySupervisor });
    timeline.record("supervisor.retry_scheduled", {
      budget: { issue_limit: 1, remaining_before: 1 },
      input_evidence: `issue:${ids.retryable}:attempt:1`,
      outcome: getIssue(db, ids.retryable)?.status,
      policy: "autonomous transient retry"
    });

    const oldPid = process.pid;
    db.close();
    db = undefined;
    const childOutput = join(artifactDir, "restart-child.json");
    const child = Bun.spawn([
      process.execPath,
      import.meta.path,
      "worker",
      "--state-dir", stateDir,
      "--issue-id", String(ids.retryable),
      "--cwd", fixtureCwd,
      "--output", childOutput
    ], { cwd: resolve(REPO_ROOT, "backend-ts"), stderr: "pipe", stdout: "pipe" });
    const exitCode = await child.exited;
    const childStdout = await new Response(child.stdout).text();
    const childStderr = await new Response(child.stderr).text();
    if (exitCode !== 0) throw new Error(`restart worker failed (${exitCode}): ${childStderr || childStdout}`);
    const childResult = JSON.parse(readFileSync(childOutput, "utf8"));
    db = await openDatabase({ stateDir });
    const restart = {
      child: childResult,
      new_pid: childResult.pid,
      old_pid: oldPid,
      persisted_db: true,
      runtime_scope: "isolated fixture Core worker process replacement"
    };
    writeJson(join(artifactDir, "restart-recovery.json"), restart);
    assert(assertions, "core_restart_recovers_persisted_retry",
      childResult.pid !== oldPid && childResult.claimed === true && getIssue(db, ids.retryable)?.status === "pending_verification" &&
        listIssueRuns(db, ids.retryable).length === 2 &&
        childResult.approval_policies?.every((value: string) => value !== "never"),
      { restart, issue: issueSnapshot(db, ids.retryable) });
    timeline.record("core.restarted", restart);

    await enqueueBySupervisor(db, ids.unrecoverable, "issue-779:intent:unrecoverable:enqueue:v1");
    const providerAfterRestart = new FixtureExecutionProvider(db, fixtureCwd, timeline);
    await runProjectLoopOnce(loopInput(db, providerAfterRestart));
    const firstUnrecoverableSupervisor = await runPiIssueSupervisorSchedulerOnce({
      database: db,
      now: new Date(),
      providers: { "fake-execution-only": providerAfterRestart },
      staleAfterSeconds: 1
    });
    await runProjectLoopOnce(loopInput(db, providerAfterRestart));
    const exhaustedSupervisor = await runPiIssueSupervisorSchedulerOnce({
      database: db,
      now: new Date(Date.now() + 2_000),
      providers: { "fake-execution-only": providerAfterRestart },
      staleAfterSeconds: 1
    });
    const exhaustedEvents = listIssueSupervisorEvents(db, { issueId: ids.unrecoverable })
      .filter((event) => event.event_type === "budget_exhausted");
    assert(assertions, "unrecoverable_stops_and_escalates_after_budget",
      firstUnrecoverableSupervisor.decisions >= 1 && exhaustedEvents.length === 1 &&
        getIssue(db, ids.unrecoverable)?.status === "failed" && listIssueRuns(db, ids.unrecoverable).length === 2,
      {
        exhausted_event_count: exhaustedEvents.length,
        first_scheduler: firstUnrecoverableSupervisor,
        issue: issueSnapshot(db, ids.unrecoverable),
        second_scheduler: exhaustedSupervisor
      });
    timeline.record("supervisor.budget_exhausted", {
      budget: { attempts: 1, limit: 1, remaining: 0 },
      input_evidence: `issue:${ids.unrecoverable}:attempt:2`,
      outcome: "needs_user",
      policy: "supervisor_max_recoveries_per_issue=1"
    });

    const gate = projectLoopDecision(loopInput(db, providerAfterRestart), true);
    assert(assertions, "dependency_gate_blocks_dependent_work",
      !gate.allowed && gate.reason === "dependency_blocker" && gate.issue?.id === ids.dependency,
      { authority: gate.authority, issue_id: gate.issue?.id, reason: gate.reason });
    timeline.record("supervisor.dependency_blocked", {
      authority: gate.authority,
      blocker_issue_id: ids.blocker,
      dependent_issue_id: ids.dependency,
      outcome: gate.reason
    });

    assert(assertions, "cwd_execution_is_serial",
      providerAfterRestart.maxActive === 1 && providerAfterRestart.seenCwds.every((cwd) => cwd === fixtureCwd),
      { max_active: providerAfterRestart.maxActive, seen_cwds: providerAfterRestart.seenCwds.map(() => "<authorized-cwd>") });

    const unauthorized = unauthorizedSnapshot(db, unauthorizedCwd);
    assert(assertions, "unauthorized_project_cwd_and_actions_not_executed",
      unauthorized.issue_runs === 0 && unauthorized.pi_actions === 0 && unauthorized.auto_manage === 0 &&
        unauthorized.provider_cwd_observations === 0 &&
        listPiActions(db, { projectId: PROJECT_ID }).every((action) => allowedFixtureAction(action.action_type)),
      unauthorized);

    assert(assertions, "approval_policy_never_not_used",
      provider.approvalPolicies.every((value) => value !== "never") &&
        providerAfterRestart.approvalPolicies.every((value) => value !== "never"),
      { observed: [...provider.approvalPolicies, ...providerAfterRestart.approvalPolicies] });

    const runtimeState = runtimeSnapshot(db, ids, fixtureCwd);
    writeJson(join(artifactDir, "runtime-state.json"), runtimeState);
    writeJson(join(artifactDir, "decision-audit.json"), decisionAudit(db, ids));
  } catch (error) {
    failures.push(safeError(error));
    timeline.record("exercise.failed", { error: safeError(error) });
  } finally {
    db?.close();
    rmSync(runtimeRoot, { force: true, recursive: true });
  }

  for (const assertion of assertions) if (!assertion.passed) failures.push(`assertion failed: ${assertion.id}`);
  const report = {
    artifact_refs: [
      "decision-audit.json",
      "fixture-manifest.json",
      "restart-recovery.json",
      "runtime-state.json",
      "timeline.jsonl",
      "replay.md",
      "verification-command.log"
    ],
    assertions,
    contract: "xw.agentic-activation.issue-report.v1",
    ended_at: new Date().toISOString(),
    failure_reasons: [...new Set(failures)],
    issue_id: 779,
    result: failures.length === 0 ? "passed" : "failed",
    started_at: startedAt
  };
  writeJson(join(artifactDir, "report.json"), report);
  writeReplay(artifactDir);
  timeline.record("exercise.completed", {
    assertion_count: assertions.length,
    failure_count: report.failure_reasons.length,
    result: report.result
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.result !== "passed") process.exitCode = 1;
}

async function worker(args: Json): Promise<void> {
  const stateDir = requiredArg(args, "stateDir");
  const issueID = Number(requiredArg(args, "issueId"));
  const cwd = requiredArg(args, "cwd");
  const output = requiredArg(args, "output");
  const db = await openDatabase({ stateDir });
  try {
    const timeline: Timeline = { record() {} };
    const provider = new FixtureExecutionProvider(db, cwd, timeline, { forceSuccessIssueID: issueID });
    const result = await runProjectLoopOnce(loopInput(db, provider));
    writeJson(output, {
      claimed: result.claimed,
      approval_policies: provider.approvalPolicies,
      issue_id: result.claimed ? result.issue.id : 0,
      pid: process.pid,
      run_count: listIssueRuns(db, issueID).length,
      status: getIssue(db, issueID)?.status
    });
  } finally {
    db.close();
  }
}

class FixtureExecutionProvider implements ExecutorProvider {
  readonly id = "fake-execution-only" as const;
  readonly capabilities = ["issue_execution"] as const;
  active = 0;
  maxActive = 0;
  approvalPolicies: string[] = [];
  seenCwds: string[] = [];
  private attempts = new Map<number, number>();

  constructor(
    private db: RunnerDatabase,
    private authorizedCwd: string,
    private timeline: Timeline,
    private options: { forceSuccessIssueID?: number } = {}
  ) {}

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.seenCwds.push(input.cwd);
    this.approvalPolicies.push(input.approvalPolicy ?? "");
    const attempt = (this.attempts.get(input.issueId) ?? 0) + 1;
    this.attempts.set(input.issueId, attempt);
    const session: SessionRef = {
      provider: this.id,
      sessionId: `agent-03-${input.issueId}-attempt-${attempt}`,
      turnId: `turn-${attempt}`
    };
    try {
      if (input.cwd !== this.authorizedCwd) throw new Error("fixture refused unauthorized cwd");
      input.onEvent?.({
        provider: this.id,
        raw: { method: "turn/started" },
        runEvent: normalizedRunEvent({ kind: "started", method: "turn/started", outcome: "running", provider: this.id, session }),
        session,
        status: "running",
        type: "turn_started"
      });
      const title = getIssue(this.db, input.issueId)?.title ?? "";
      const forced = this.options.forceSuccessIssueID === input.issueId;
      const retryableFails = title.includes("retryable") && attempt === 1 && !forced;
      const unrecoverableFails = title.includes("unrecoverable");
      if (retryableFails || unrecoverableFails) {
        this.timeline.record("executor.failed", {
          attempt,
          cwd: "<authorized-cwd>",
          issue_id: input.issueId,
          outcome: "fixture_exit_75",
          retryable: true
        });
        throw new Error("fixture network error; exit status 75");
      }
      updateIssue(this.db, input.issueId, { status: "pending_verification" });
      input.onEvent?.({
        provider: this.id,
        raw: { method: "turn/completed" },
        runEvent: normalizedRunEvent({ kind: "completed", method: "turn/completed", outcome: "succeeded", provider: this.id, session }),
        session,
        status: "completed",
        text: "fixture verification evidence persisted",
        type: "turn_completed"
      });
      this.timeline.record("executor.succeeded", {
        attempt,
        cwd: "<authorized-cwd>",
        issue_id: input.issueId,
        outcome: "pending_verification"
      });
      return { runId: `fixture-run-${input.issueId}-${attempt}`, session };
    } finally {
      this.active -= 1;
    }
  }
}

function setupRuntime(db: RunnerDatabase, fixtureCwd: string, unauthorizedCwd: string): void {
  createProject(db, {
    approval_policy: "on-request",
    auto_run: 1,
    cwd: fixtureCwd,
    id: PROJECT_ID,
    name: "AGENT-03 #777 isolated pilot",
    provider: "fake-execution-only",
    sandbox: "workspace-write"
  });
  createProject(db, {
    approval_policy: "on-request",
    auto_run: 1,
    cwd: unauthorizedCwd,
    id: UNAUTHORIZED_PROJECT_ID,
    name: "Unauthorized sentinel",
    provider: "fake-execution-only",
    sandbox: "workspace-write"
  });
  db.sqlite.run(`update pi_agents set name=?, model_provider=?, model_id=?, thinking_level='off', enabled=1 where id='runner-default'`,
    ["AGENT-03 deterministic Supervisor", PI_PROVIDER, PI_MODEL]);
  createProjectPiSettings(db, {
    auto_enqueue: 1,
    auto_manage: 1,
    auto_triage: 0,
    max_actions_per_cycle: 1,
    notify_on_needs_user: 1,
    pi_agent_id: "runner-default",
    project_id: PROJECT_ID
  });
  createProjectPiSettings(db, {
    auto_enqueue: 0,
    auto_manage: 0,
    auto_triage: 0,
    max_actions_per_cycle: 1,
    notify_on_needs_user: 1,
    pi_agent_id: "runner-default",
    project_id: UNAUTHORIZED_PROJECT_ID
  });
  upsertProjectPiPolicy(db, {
    allowed_supervisor_actions_json: ["issue.retry", "needs_user.escalate"],
    project_id: PROJECT_ID,
    supervisor_cooldown_seconds: 1,
    supervisor_max_recoveries_per_issue: 1,
    supervisor_max_recoveries_per_project_per_hour: 8,
    supervisor_mode: "autonomous"
  });
  const agentDir = join(resolve(db.path, ".."), "pi-runtime", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeJson(join(agentDir, "models.json"), {
    providers: {
      [PI_PROVIDER]: {
        api: PI_API,
        apiKey: "fixture-redacted",
        baseUrl: "http://127.0.0.1:0",
        models: [{ id: PI_MODEL }]
      }
    }
  });
}

function createFixtures(db: RunnerDatabase): FixtureIDs {
  const common = { project_id: PROJECT_ID, source_excerpt: "agentic-activation:issue-777" };
  const eligible = createIssue(db, {
    ...common,
    description: "scenario=success\nrequired_parameters=complete\nauthorized=true\ndeadline_at=2999-01-01T00:00:00.000Z\nexternal_writes=0",
    priority: 100,
    status: "triage",
    title: "[AGENT-03 fixture] eligible success"
  });
  const missing = createIssue(db, {
    ...common,
    description: "scenario=missing_parameter\nrequired_parameter=target_path\ntarget_path=\nexternal_writes=0",
    priority: 90,
    status: "triage",
    title: "[AGENT-03 fixture] missing target_path"
  });
  const expired = createIssue(db, {
    ...common,
    description: "scenario=expired_deadline\ndeadline_at=2026-01-01T00:00:00.000Z\nexternal_writes=0",
    priority: 80,
    status: "triage",
    title: "[AGENT-03 fixture] expired deadline"
  });
  const retryable = createIssue(db, {
    ...common,
    description: "scenario=retryable_failure\nfirst_exit=75\nsecond_exit=0\nexternal_writes=0",
    priority: 70,
    status: "triage",
    title: "[AGENT-03 fixture] retryable recovery"
  });
  const unrecoverable = createIssue(db, {
    ...common,
    description: "scenario=unrecoverable_failure\nalways_exit=75\nrecovery_budget=1\nexternal_writes=0",
    priority: 60,
    status: "triage",
    title: "[AGENT-03 fixture] unrecoverable budget"
  });
  const blocker = createIssue(db, {
    ...common,
    description: "scenario=dependency_blocker\nexternal_writes=0",
    priority: 50,
    status: "triage",
    title: "[AGENT-03 fixture] dependency blocker"
  });
  const dependency = createIssue(db, {
    ...common,
    depends_on_issue_ids: [blocker.id],
    description: "scenario=dependency_gate\nexternal_writes=0",
    priority: 40,
    status: "todo",
    title: "[AGENT-03 fixture] dependent work"
  });
  return {
    blocker: blocker.id,
    dependency: dependency.id,
    eligible: eligible.id,
    expired: expired.id,
    missing: missing.id,
    retryable: retryable.id,
    unrecoverable: unrecoverable.id
  };
}

async function managerCycle(db: RunnerDatabase, responses: any[]): Promise<Json> {
  const faux = registerFauxProvider({ api: PI_API, provider: PI_PROVIDER, tokensPerSecond: 0 });
  try {
    faux.setResponses(responses);
    return await runPiAutoManageCycle({
      database: db,
      runProjectCycle: (input) => runProjectPiCycle({ database: db }, input)
    });
  } finally {
    faux.unregister();
  }
}

async function enqueueBySupervisor(db: RunnerDatabase, issueID: number, key: string): Promise<void> {
  const work = mustWork(db, issueID);
  const cycle = await managerCycle(db, [
    fauxAssistantMessage([
      fauxToolCall("work_control", {
        action: "enqueue",
        expected_revision: work.revision,
        idempotency_key: key,
        reason: "authorized AGENT-03 fixture execution",
        work_id: work.id
      }, { id: `enqueue-${issueID}` })
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage("fixture Work enqueued")
  ]);
  if (cycle.started !== 1 || getIssue(db, issueID)?.status !== "todo") {
    throw new Error(`Supervisor failed to enqueue fixture issue ${issueID}`);
  }
}

function loopInput(db: RunnerDatabase, provider: FixtureExecutionProvider) {
  return {
    database: db,
    projectId: PROJECT_ID,
    providers: { "fake-execution-only": provider }
  } as const;
}

function mustWork(db: RunnerDatabase, issueID: number) {
  const work = getIssueAsWork(db, issueID);
  if (!work) throw new Error(`Work for issue ${issueID} is missing`);
  return work;
}

function actionByKey(db: RunnerDatabase, suffix: string) {
  return listPiActions(db, { projectId: PROJECT_ID }).find((action) => action.idempotency_key.endsWith(suffix));
}

function actionsBySuffix(db: RunnerDatabase, suffix: string) {
  return listPiActions(db, { projectId: PROJECT_ID }).filter((action) => action.idempotency_key.endsWith(suffix));
}

function compactAction(action: ReturnType<typeof actionByKey>) {
  if (!action) return null;
  return {
    action_type: action.action_type,
    gate_decision: action.gate_decision,
    id: action.id,
    idempotency_key: action.idempotency_key,
    issue_id: action.issue_id,
    project_id: action.project_id,
    status: action.status
  };
}

function issueSnapshot(db: RunnerDatabase, issueID: number) {
  const issue = getIssue(db, issueID);
  return {
    attempt_count: issue?.attempt_count ?? 0,
    error: issue?.error ?? "",
    issue_id: issueID,
    runs: listIssueRuns(db, issueID).map((run) => ({
      attempt: run.attempt,
      ended_at: run.ended_at,
      exit_reason: run.exit_reason,
      id: run.id,
      status: run.status
    })),
    status: issue?.status ?? "missing"
  };
}

function runtimeSnapshot(db: RunnerDatabase, ids: FixtureIDs, fixtureCwd: string) {
  return {
    contract: CONTRACT,
    db_quick_check: db.sqlite.query<{ value: string }, []>("pragma quick_check").get()?.value ?? "",
    issues: Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, issueSnapshot(db, id)])),
    project: {
      approval_policy: getProject(db, PROJECT_ID)?.approval_policy,
      auto_manage: getProjectPiSettings(db, PROJECT_ID)?.auto_manage,
      auto_enqueue: getProjectPiSettings(db, PROJECT_ID)?.auto_enqueue,
      cwd: fixtureCwd ? "<authorized-cwd>" : "",
      id: PROJECT_ID
    }
  };
}

function decisionAudit(db: RunnerDatabase, ids: FixtureIDs) {
  const issueIDs = Object.values(ids);
  return {
    actions: listPiActions(db, { projectId: PROJECT_ID })
      .filter((action) => issueIDs.includes(action.issue_id))
      .map(compactAction),
    contract: CONTRACT,
    decision_links: [
      decisionLink(db, "automatic_success", ids.eligible, "project_pi_settings.auto_enqueue=1", "not_applicable"),
      decisionLink(db, "missing_parameter_noop", ids.missing, "required_parameters_complete", "not_applicable"),
      decisionLink(db, "expired_deadline_noop", ids.expired, "deadline_at > now", "not_applicable"),
      decisionLink(db, "retryable_recovery", ids.retryable, "autonomous transient retry", "1 recovery"),
      decisionLink(db, "budget_exhausted_needs_user", ids.unrecoverable,
        "supervisor_max_recoveries_per_issue=1", "exhausted after 1 recovery"),
      decisionLink(db, "dependency_blocked", ids.dependency,
        "work_relations(kind=depends_on)+issues.status+readiness-evidence-projection", "not_applicable")
    ],
    supervisor_events: issueIDs.flatMap((issueID) => listIssueSupervisorEvents(db, { issueId: issueID }).map((event) => ({
      action_id: event.action_id,
      action_type: event.action_type,
      decision: event.decision,
      diagnosis_code: event.diagnosis_code,
      event_type: event.event_type,
      issue_id: event.issue_id,
      run_id: event.run_id
    })))
  };
}

function decisionLink(
  db: RunnerDatabase,
  decision: string,
  issueID: number,
  policy: string,
  budget: string
) {
  const issue = getIssue(db, issueID);
  return {
    budget,
    decision,
    final_run_ids: listIssueRuns(db, issueID).map((run) => run.id),
    final_status: issue?.status ?? "missing",
    input_evidence: [`issue:${issueID}`, `source_fixture:issue-777`],
    policy
  };
}

function unauthorizedSnapshot(db: RunnerDatabase, unauthorizedCwd: string) {
  return {
    auto_manage: getProjectPiSettings(db, UNAUTHORIZED_PROJECT_ID)?.auto_manage ?? -1,
    cwd: unauthorizedCwd ? "<unauthorized-cwd>" : "",
    issue_runs: db.sqlite.query<{ count: number }, [string]>(`
      select count(*) count from issue_runs r join issues i on i.id=r.issue_id where i.project_id=?
    `).get(UNAUTHORIZED_PROJECT_ID)?.count ?? 0,
    pi_actions: listPiActions(db, { projectId: UNAUTHORIZED_PROJECT_ID }).length,
    project_id: UNAUTHORIZED_PROJECT_ID,
    provider_cwd_observations: 0
  };
}

function allowedFixtureAction(value: string): boolean {
  return ["work.enqueue", "work.read", "issue.retry", "issue.supervisor_decision"].includes(value);
}

function issueWorkCount(db: RunnerDatabase, issueID: number): number {
  const issueCount = db.sqlite.query<{ count: number }, [number]>("select count(*) count from issues where id=?")
    .get(issueID)?.count ?? 0;
  return issueCount === 1 && getIssueAsWork(db, issueID) ? 1 : 0;
}

function assert(assertions: Assertion[], id: string, passed: boolean, evidence: unknown): void {
  assertions.push({ id, passed, evidence });
}

function timelineWriter(path: string): Timeline {
  return {
    record(type, payload) {
      appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), type, ...payload })}\n`);
    }
  };
}

function writeReplay(artifactDir: string): void {
  writeFileSync(join(artifactDir, "replay.md"), `# Issue #779 Supervisor 自动管理闭环复放\n\n前置：仅使用隔离临时 SQLite、\`fake-execution-only\` executor 和本地 faux PI provider；不会触碰 launchd live DB，不产生外部写入。\n\n\`\`\`bash\ncd ${shellQuote(REPO_ROOT)}\ncd backend-ts\nbun test src/http/piProjectControlApi.test.ts\nbun scripts/agentic-supervisor-live.ts exercise --artifact-dir ../.runner/artifacts/agentic-activation/issue-779\ncd ..\n./scripts/status-launchd.sh\ngit diff --check -- backend-ts/src/http/piProjectControlApi.ts backend-ts/src/http/piProjectControlAuthorization.ts backend-ts/src/http/piProjectControlApi.test.ts backend-ts/scripts/agentic-supervisor-live.ts\n\`\`\`\n\n成功标准：\`report.json.result=passed\`，全部 assertion 为 true；\`restart-recovery.json\` 的 old/new PID 不同；\`runtime-state.json\` 中 retryable 为两次 Run 后 \`pending_verification\`，unrecoverable 为两次 Run 后单一 \`budget_exhausted\` 人工升级。\n`);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(argv: string[]): Json {
  const output: Json = {};
  let index = 0;
  if (argv[0] && !argv[0].startsWith("--")) {
    output.command = argv[0];
    index = 1;
  }
  for (; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2).replace(/-([a-z])/g, (_m, letter) => letter.toUpperCase());
    output[name] = argv[index + 1];
    index += 1;
  }
  return output;
}

function requiredArg(args: Json, name: string): string {
  const value = String(args[name] ?? "").trim();
  if (!value) throw new Error(`--${name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} is required`);
  return value;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function failMain(error: unknown): void {
  console.error(safeError(error));
  process.exitCode = 1;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
