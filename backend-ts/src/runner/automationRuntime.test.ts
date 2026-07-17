import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getAutomationExecutionLink } from "../db/repositories/automationExecutionLinks.ts";
import { createAutomation, listAutomationRuns } from "../db/repositories/automations.ts";
import { listStoredEvidence } from "../db/repositories/evidence.ts";
import { listStoredHandoffs } from "../db/repositories/handoffs.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { getIssueAsWork } from "../domain/work/issueAdapter.ts";
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
      expect(getIssue(db, link.issue_id)).toMatchObject({ status: "pending_verification" });
      expect(getIssueAsWork(db, link.issue_id)?.provenance.origin).toMatchObject({
        authority: "automation_definitions",
        external_id: `${automation.id}/${automationRun.run_id}`,
        kind: "automation_trigger",
        source_event_id: `automation_runs:${automationRun.run_id}`
      });
      expect(listIssueRuns(db, link.issue_id)).toHaveLength(1);
      expect(listStoredEvidence(db, { issue_ids: [link.issue_id], limit: 10 }).items).toMatchObject([
        { evidence: {
          decisive_output: { facts: {
            automation_mode: "execute_allowed",
            permission_policy_ref: "project-policy:demo"
          } },
          status: "passed",
          run_id: link.run_id
        } }
      ]);
      expect(listStoredHandoffs(db, { work_id: link.work_id, limit: 10 }).items).toMatchObject([
        { handoff: { status: "ready", run_ids: [link.run_id], review_ref: `automation_runs:${automationRun.run_id}` } }
      ]);
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
      expect(getIssue(db, link.issue_id)).toMatchObject({ status: "cancelled" });
      expect(listStoredEvidence(db, { issue_ids: [link.issue_id], limit: 10 }).items[0]?.evidence.status).toBe("blocked");
      expect(listStoredHandoffs(db, { work_id: link.work_id, limit: 10 }).items[0]?.handoff.status).toBe("draft");
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
      expect(listStoredEvidence(db, { issue_ids: [link.issue_id], limit: 10 }).items.map((item) => item.evidence.status))
        .toEqual(["failed"]);

      const retried = await cycle(db, provider, new Date("2026-07-18T10:01:00.000Z"));
      expect(retried.automationCore).toMatchObject({ executed: 1, scanned: 1 });
      expect(provider.inputs).toHaveLength(2);
      expect(listAutomationRuns(db, automation.id)[0]?.status).toBe("succeeded");
      expect(listIssueRuns(db, link.issue_id)).toHaveLength(1);
      expect(listStoredEvidence(db, { issue_ids: [link.issue_id], limit: 10 }).items.map((item) => item.evidence.status).sort())
        .toEqual(["failed", "passed"]);
      expect(listStoredHandoffs(db, { work_id: link.work_id, limit: 10 }).items).toHaveLength(2);
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
  db.sqlite.run(`insert into projects (id, name, cwd, provider, created_at, updated_at)
    values ('demo', 'Demo', ?, 'fake-execution-only', ?, ?)`, [cwd, NOW.toISOString(), NOW.toISOString()]);
  return db;
}

function createFixture(db: RunnerDatabase, suffix: string, mode: "execute_allowed" | "observe") {
  return createAutomation(db, {
    id: `automation:${suffix}`,
    idempotency_namespace: `automation:${suffix}`,
    mode,
    name: `Automation ${suffix}`,
    next_run_at: "2026-07-18T09:59:30.000Z",
    owner: { kind: "project", project_id: "demo" },
    permission_policy_ref: "project-policy:demo",
    status: "active",
    workflow_ref: INVESTIGATE_WORKFLOW_REF,
    trigger_created_by: "system",
    trigger: { type: "continuous", config: { poll_interval_seconds: 60 } }
  }, "2026-07-18T09:00:00.000Z");
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}
