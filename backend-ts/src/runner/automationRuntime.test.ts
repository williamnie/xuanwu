import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getAutomationExecutionLink } from "../db/repositories/automationExecutionLinks.ts";
import { createAutomation, listAutomationRuns } from "../db/repositories/automations.ts";
import { listStoredEvidence } from "../db/repositories/evidence.ts";
import { listStoredHandoffs } from "../db/repositories/handoffs.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import {
  createPiConversation,
  createProjectPiSettings,
  pausePiHeartbeat,
  upsertProjectPiPolicy
} from "../db/repositories/pi.ts";
import { getIssueAsWork } from "../domain/work/issueAdapter.ts";
import { createSupervisorCommitment } from "../pi/supervisorCommitments.ts";
import type { ExecutorProvider, ProviderRunInput, ProviderRunResult } from "../providers/types.ts";
import { INVESTIGATE_WORKFLOW_REF } from "../workflows/investigate.ts";
import { createPiAutoManageScheduler, runScheduleLayerCycle } from "./piAutoManageScheduler.ts";

const roots: string[] = [];
const NOW = new Date("2026-07-18T10:00:00.000Z");

class FixtureProvider implements ExecutorProvider {
  readonly id = "fake-execution-only" as const;
  readonly capabilities = ["issue_execution"] as const;
  readonly inputs: ProviderRunInput[] = [];

  constructor(private failuresRemaining = 0) {}

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    this.inputs.push(input);
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("fixture provider unavailable");
    }
    return { runId: `fixture-run-${this.inputs.length}` };
  }
}

class FixtureClock {
  timers: Array<{ callback: () => void; cancelled: boolean }> = [];

  clearTimeout(timer: { cancelled: boolean }): void {
    timer.cancelled = true;
  }

  setTimeout(callback: () => void) {
    const timer = { callback, cancelled: false };
    this.timers.push(timer);
    return timer;
  }

  runNext(): void {
    const timer = this.timers.shift();
    if (timer && !timer.cancelled) timer.callback();
  }
}

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("native Automation scheduler composition", () => {
  test("constructs the native executor on the production timer path", async () => {
    const db = await fixture();
    const provider = new FixtureProvider();
    const clock = new FixtureClock();
    try {
      const automation = createFixture(db, "timer", "execute_allowed");
      const scheduler = createPiAutoManageScheduler({
        clock,
        database: db,
        intervalMs: 1,
        providers: { [provider.id]: provider },
        runProjectCycle: async () => ({}),
        runSupervisor: false,
        watchdogNow: NOW
      });

      scheduler.start();
      clock.runNext();
      await waitUntil(() => listAutomationRuns(db, automation.id)[0]?.status === "succeeded");
      scheduler.stop();

      const automationRun = listAutomationRuns(db, automation.id)[0]!;
      expect(provider.inputs).toHaveLength(1);
      expect(getAutomationExecutionLink(db, automationRun.run_id)).not.toBeNull();
    } finally {
      db.close();
    }
  });

  test("dispatches a registered Workflow through the production composition exactly once", async () => {
    const db = await fixture();
    const provider = new FixtureProvider();
    try {
      const automation = createFixture(db, "success", "execute_allowed");
      const first = await cycle(db, provider, NOW);
      const duplicate = await cycle(db, provider, NOW);

      expect(first.automationCore).toMatchObject({ executed: 1, scanned: 1, skipped: 0 });
      expect(duplicate.automationCore).toMatchObject({ executed: 0, scanned: 0 });
      expect(provider.inputs).toHaveLength(1);
      expect(provider.inputs[0]?.prompt).toContain(`Workflow ${INVESTIGATE_WORKFLOW_REF}`);

      const automationRun = listAutomationRuns(db, automation.id)[0]!;
      const link = getAutomationExecutionLink(db, automationRun.run_id)!;
      expect(link).toMatchObject({ automation_id: automation.id, workflow_ref: INVESTIGATE_WORKFLOW_REF });
      expect(getIssue(db, link.issue_id)).toMatchObject({ status: "in_progress" });
      expect(getIssueAsWork(db, link.issue_id)?.provenance.origin).toMatchObject({
        authority: "automation_definitions",
        external_id: `${automation.id}/${automationRun.run_id}`,
        kind: "automation_trigger",
        source_event_id: `automation_runs:${automationRun.run_id}`
      });
      expect(listIssueRuns(db, link.issue_id)).toHaveLength(1);
      expect(listStoredEvidence(db, { issue_ids: [link.issue_id], limit: 10 }).items).toEqual([]);
      expect(listStoredHandoffs(db, { work_id: link.work_id, limit: 10 }).items).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("maps observe mode to an audited skip without invoking a provider", async () => {
    const db = await fixture();
    const provider = new FixtureProvider();
    try {
      const automation = createFixture(db, "observe", "observe");
      const result = await cycle(db, provider, NOW);
      const automationRun = listAutomationRuns(db, automation.id)[0]!;
      const link = getAutomationExecutionLink(db, automationRun.run_id)!;

      expect(result.automationCore).toMatchObject({ executed: 0, scanned: 1, skipped: 1 });
      expect(automationRun.status).toBe("skipped");
      expect(provider.inputs).toHaveLength(0);
      expect(getIssue(db, link.issue_id)).toMatchObject({ status: "in_progress" });
      expect(listStoredEvidence(db, { issue_ids: [link.issue_id], limit: 10 }).items).toEqual([]);
      expect(listStoredHandoffs(db, { work_id: link.work_id, limit: 10 }).items).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("retries a failed dispatch on the same linked Work and Run", async () => {
    const db = await fixture();
    const provider = new FixtureProvider(1);
    try {
      const automation = createFixture(db, "retry", "execute_allowed");
      const failed = await cycle(db, provider, NOW);
      const queuedRun = listAutomationRuns(db, automation.id)[0]!;
      const link = getAutomationExecutionLink(db, queuedRun.run_id)!;

      expect(failed.automationCore).toMatchObject({ failed: 1, scanned: 1 });
      expect(queuedRun.status).toBe("queued");
      expect(listStoredEvidence(db, { issue_ids: [link.issue_id], limit: 10 }).items).toEqual([]);

      const retried = await cycle(db, provider, new Date("2026-07-18T10:01:00.000Z"));
      expect(retried.automationCore).toMatchObject({ executed: 1, scanned: 1 });
      expect(provider.inputs).toHaveLength(2);
      expect(listAutomationRuns(db, automation.id)[0]?.status).toBe("succeeded");
      expect(listIssueRuns(db, link.issue_id)).toHaveLength(2);
      expect(listStoredEvidence(db, { issue_ids: [link.issue_id], limit: 10 }).items).toEqual([]);
      expect(listStoredHandoffs(db, { work_id: link.work_id, limit: 10 }).items).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("records a deterministic no-op without manufacturing Work when no context changed", async () => {
    const db = await fixture();
    const provider = new FixtureProvider();
    try {
      const automation = createFixture(db, "no-op", "execute_allowed", { commitment: false });
      const result = await cycle(db, provider, NOW);
      const run = listAutomationRuns(db, automation.id)[0]!;

      expect(result.automationCore).toMatchObject({ executed: 0, scanned: 1, skipped: 1 });
      expect(run).toMatchObject({ status: "skipped" });
      expect(run.summary.detail).toContain("standing order no-op");
      expect(provider.inputs).toHaveLength(0);
      expect(getAutomationExecutionLink(db, run.run_id)).toBeNull();
      expect(db.sqlite.query<{ count: number }, []>("select count(*) as count from issues").get()?.count).toBe(0);
      expect(db.sqlite.query<{ detail: string; event_type: string }, [string]>(`
        select event_type, detail from automation_run_events where run_id=? order by rowid desc limit 1
      `).get(run.run_id)).toMatchObject({
        detail: "standing order no-op: no changed issue signal or active Supervisor commitment",
        event_type: "automation.run_skipped.v1"
      });
    } finally {
      db.close();
    }
  });

  test("honors project quiet hours before selecting context or creating Work", async () => {
    const db = await fixture();
    const provider = new FixtureProvider();
    try {
      const automation = createFixture(db, "quiet", "execute_allowed");
      upsertProjectPiPolicy(db, {
        project_id: "demo",
        quiet_hours_json: { daily: [{ end: "11:00", start: "09:00" }] },
        timezone: "UTC"
      });

      const result = await cycle(db, provider, NOW);
      const run = listAutomationRuns(db, automation.id)[0]!;

      expect(result.automationCore).toMatchObject({ executed: 0, scanned: 1, skipped: 1 });
      expect(run.summary.detail).toContain("quiet hours until 2026-07-18T11:00:00.000Z");
      expect(provider.inputs).toHaveLength(0);
      expect(getAutomationExecutionLink(db, run.run_id)).toBeNull();
    } finally {
      db.close();
    }
  });

  test("honors the existing project heartbeat pause control", async () => {
    const db = await fixture();
    const provider = new FixtureProvider();
    try {
      const automation = createFixture(db, "paused", "execute_allowed");
      pausePiHeartbeat(db, { reason: "maintenance", scopeId: "demo", scopeType: "project" });

      const result = await cycle(db, provider, NOW);
      const run = listAutomationRuns(db, automation.id)[0]!;

      expect(result.automationCore).toMatchObject({ executed: 0, scanned: 1, skipped: 1 });
      expect(run.summary.detail).toContain("project heartbeat is paused for demo");
      expect(provider.inputs).toHaveLength(0);
      expect(getAutomationExecutionLink(db, run.run_id)).toBeNull();
    } finally {
      db.close();
    }
  });

  test("processes one changed project context once across competing standing orders", async () => {
    const db = await fixture();
    const provider = new FixtureProvider();
    try {
      createProjectPiSettings(db, { project_id: "demo" });
      const automations = Array.from({ length: 6 }, (_, index) =>
        createFixture(db, `budget-${index + 1}`, "execute_allowed"));

      const result = await cycle(db, provider, NOW);
      const runs = automations.flatMap((automation) => listAutomationRuns(db, automation.id));

      expect(result.automationCore).toMatchObject({ executed: 6, scanned: 6, skipped: 0 });
      expect(provider.inputs).toHaveLength(6);
      expect(runs.filter((run) => run.status === "succeeded")).toHaveLength(6);

      const next = await cycle(db, provider, new Date("2026-07-18T10:01:00.000Z"));
      expect(next.automationCore).toMatchObject({ executed: 6, scanned: 6, skipped: 0 });
      expect(provider.inputs).toHaveLength(12);
      expect(listAutomationRuns(db, automations[0]!.id).filter((run) => run.status === "succeeded")).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test("restores the standing-order cursor after restart and isolates project context", async () => {
    let db = await fixture();
    const provider = new FixtureProvider();
    const automation = createFixture(db, "restart", "execute_allowed");
    insertProject(db, "other", "/tmp/standing-order-other");
    const isolated = createFixture(db, "isolated", "execute_allowed", { commitment: false, projectID: "other" });
    try {
      const first = await cycle(db, provider, NOW);
      expect(first.automationCore).toMatchObject({ executed: 1, scanned: 2, skipped: 1 });
      expect(provider.inputs).toHaveLength(1);
      expect(provider.inputs[0]?.projectId).toBe("demo");
      expect(listAutomationRuns(db, isolated.id)[0]?.summary.detail).toContain("standing order no-op");

      const stateDir = stateDirFor(db);
      db.close();
      db = await openDatabase({ stateDir });
      const resumed = await cycle(db, provider, new Date("2026-07-18T10:01:00.000Z"));

      expect(resumed.automationCore).toMatchObject({ executed: 1, scanned: 2, skipped: 1 });
      expect(provider.inputs).toHaveLength(2);
      expect(listAutomationRuns(db, automation.id).map((run) => run.status).sort()).toEqual(["succeeded", "succeeded"]);
      expect(db.sqlite.query<{ count: number }, [string]>(`
        select count(*) as count from automation_execution_links where automation_id=?
      `).get(automation.id)?.count).toBe(2);
    } finally {
      db.close();
    }
  });
});

async function cycle(db: RunnerDatabase, provider: FixtureProvider, now: Date) {
  return runScheduleLayerCycle({
    database: db,
    providers: { [provider.id]: provider },
    runProjectCycle: async () => ({}),
    runSupervisor: false,
    watchdogNow: now
  });
}

async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "automation-runtime-"));
  roots.push(root);
  const cwd = join(root, "repo");
  await mkdir(cwd);
  const db = await openDatabase({ stateDir: join(root, "state") });
  insertProject(db, "demo", cwd);
  return db;
}

function createFixture(
  db: RunnerDatabase,
  suffix: string,
  mode: "execute_allowed" | "observe",
  options: { commitment?: boolean; projectID?: string } = {}
) {
  const projectID = options.projectID ?? "demo";
  if (options.commitment !== false) createCommitmentFixture(db, projectID, suffix);
  return createAutomation(db, {
    id: `automation:${suffix}`,
    idempotency_namespace: `automation:${suffix}`,
    mode,
    name: `Automation ${suffix}`,
    next_run_at: "2026-07-18T09:59:30.000Z",
    owner: { kind: "project", project_id: projectID },
    permission_policy_ref: `project-policy:${projectID}`,
    status: "active",
    workflow_ref: INVESTIGATE_WORKFLOW_REF,
    trigger_created_by: "system",
    trigger: { type: "continuous", config: { poll_interval_seconds: 60 } }
  }, "2026-07-18T09:00:00.000Z");
}

function createCommitmentFixture(db: RunnerDatabase, projectID: string, suffix: string): void {
  const conversationID = `standing-order-${projectID}-${suffix}`;
  createPiConversation(db, { id: conversationID, pi_agent_id: "fixture-agent", project_id: projectID, title: suffix });
  const issue = createIssue(db, {
    description: `Standing Order context ${suffix}`,
    project_id: projectID,
    status: "in_progress",
    title: `Commitment ${suffix}`
  });
  createSupervisorCommitment(db, {
    condition: { commitment: { schema_version: "xw.supervisor-commitment.v1" } },
    issue_ids: [issue.id],
    origin_conversation_id: conversationID,
    project_id: projectID,
    requested_by: "fixture-user",
    source_event_id: `standing-order-source-${projectID}-${suffix}`
  });
}

function insertProject(db: RunnerDatabase, id: string, cwd: string): void {
  db.sqlite.run(`insert into projects (id, name, cwd, provider, created_at, updated_at)
    values (?, ?, ?, 'fake-execution-only', ?, ?)`, [id, id, cwd, NOW.toISOString(), NOW.toISOString()]);
}

function stateDirFor(db: RunnerDatabase): string {
  const row = db.sqlite.query<{ file: string }, []>("pragma database_list").all()
    .find((item) => item.file.endsWith("runner.db"));
  return row?.file.slice(0, -"/runner.db".length) ?? "";
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}
