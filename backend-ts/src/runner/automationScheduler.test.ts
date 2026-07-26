import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createAutomation, getAutomation, listAutomationRuns } from "../db/repositories/automations.ts";
import { claimDueAutomationRuns, nextCronOccurrence } from "../db/repositories/automationScheduler.ts";
import { listPiGuardianAlerts, upsertProjectPiPolicy } from "../db/repositories/pi.ts";
import { runDueAutomations } from "./automationScheduler.ts";
import { runScheduleLayerCycle } from "./piAutoManageScheduler.ts";

const roots: string[] = [];
const NOW = new Date("2026-06-02T10:00:00.000Z");

afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

describe("P08 Automation scheduler", () => {
  test("leases a due run atomically across instances and preserves its idempotency key", async () => {
    const root = await fixtureRoot();
    const first = await openDatabase({ stateDir: join(root, "state") });
    const second = await openDatabase({ stateDir: join(root, "state") });
    try {
      const automation = createFixture(first, "2026-06-02T09:59:30.000Z");
      let secondResult: Awaited<ReturnType<typeof runDueAutomations>> | undefined;
      const firstResult = await runDueAutomations({
        database: first, now: NOW,
        executeAutomation: async () => {
          secondResult = await runDueAutomations({ database: second, now: NOW, executeAutomation: async () => ({ detail: "duplicate" }) });
          return { detail: "once" };
        }
      });
      expect(firstResult).toMatchObject({ executed: 1, scanned: 1 });
      expect(secondResult).toEqual({ deadLettered: 0, executed: 0, failed: 0, scanned: 0, skipped: 0 });
      expect(listAutomationRuns(first, automation.id)).toMatchObject([{ idempotency_key: expect.stringContaining("2026-06-02T09:59:30.000Z"), status: "succeeded" }]);
    } finally { first.close(); second.close(); }
  });

  test("recovers an expired lease after restart through bounded backoff", async () => {
    const root = await fixtureRoot();
    const first = await openDatabase({ stateDir: join(root, "state") });
    const restarted = await openDatabase({ stateDir: join(root, "state") });
    try {
      createFixture(first, "2026-06-02T09:59:30.000Z");
      expect(claimDueAutomationRuns(first, NOW).claimed).toHaveLength(1);
      expect(await runDueAutomations({ database: restarted, now: new Date("2026-06-02T10:05:00.000Z"), executeAutomation: async () => ({}) }))
        .toMatchObject({ scanned: 0 });
      const recovered = await runDueAutomations({
        database: restarted, now: new Date("2026-06-02T10:06:00.000Z"), executeAutomation: async () => ({ detail: "recovered" })
      });
      expect(recovered).toMatchObject({ executed: 1, scanned: 1 });
      expect(restarted.sqlite.query("select event_type from automation_run_events order by occurred_at, event_id").all())
        .toEqual(expect.arrayContaining([expect.objectContaining({ event_type: "automation.run_lease_expired.v1" })]));
    } finally { first.close(); restarted.close(); }
  });

  test("records a missed trigger as skipped rather than replaying it", async () => {
    const db = await fixture();
    try {
      const automation = createFixture(db, "2026-06-02T09:00:00.000Z");
      const result = await runDueAutomations({ database: db, now: NOW, executeAutomation: async () => { throw new Error("must not execute"); } });
      expect(result).toEqual({ deadLettered: 0, executed: 0, failed: 0, scanned: 0, skipped: 1 });
      expect(listAutomationRuns(db, automation.id)).toMatchObject([{ status: "skipped" }]);
      expect(getAutomation(db, automation.id)?.next_run_at).toBe("2026-06-03T09:00:00.000Z");
    } finally { db.close(); }
  });

  test("uses IANA timezones across DST gaps and does not duplicate a fall-back local slot", () => {
    expect(nextCronOccurrence("30 2 * * *", "America/New_York", new Date("2026-03-08T06:59:00.000Z"))?.toISOString())
      .toBe("2026-03-09T06:30:00.000Z");
    const first = nextCronOccurrence("30 1 * * *", "America/New_York", new Date("2026-11-01T05:29:00.000Z"));
    expect(first?.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(nextCronOccurrence("30 1 * * *", "America/New_York", first!)?.toISOString()).toBe("2026-11-02T06:30:00.000Z");
  });

  test("runs the governed native executor from the system schedule layer", async () => {
    const db = await fixture();
    try {
      createFixture(db, "2026-06-02T09:59:30.000Z");
      const result = await runScheduleLayerCycle({
        database: db,
        runAutomationCore: async ({ automation }) => ({ detail: `ran ${automation.id}` }),
        runProjectCycle: async () => ({}),
        runSupervisor: false,
        watchdogNow: NOW
      });
      expect(result.automationCore).toMatchObject({ executed: 1, scanned: 1 });
    } finally { db.close(); }
  });

  test("executes due Automation work before entering the slow PI Supervisor boundary", async () => {
    const db = await fixture();
    const order: string[] = [];
    try {
      createFixture(db, "2026-06-02T09:59:30.000Z");
      insertSupervisorCandidate(db);

      const result = await runScheduleLayerCycle({
        database: db,
        runAutomationCore: async () => {
          order.push("automation");
          return { detail: "ran before supervisor" };
        },
        runProjectCycle: async () => ({}),
        runSupervisorDecision: async () => {
          order.push("supervisor");
          return {
            decision: {
              confidence: "high",
              decision: "noop",
              evidence_refs: ["latest_run", "session"],
              expected_outcome: "current state remains unchanged",
              fallback_if_no_progress: "retry_issue",
              rationale: "fixture only verifies scheduler phase order",
              recovery_message: "",
              risk_level: "low"
            },
            raw_text: "{}",
            valid: true
          };
        },
        watchdogNow: NOW
      });

      expect(result.automationCore).toMatchObject({ executed: 1, scanned: 1 });
      expect(result.supervisor).toMatchObject({ decisions: 1, signaled: 1 });
      expect(order).toEqual(["automation", "supervisor"]);
    } finally { db.close(); }
  });

  test("executes a due manual trigger once and never scans a paused definition", async () => {
    const db = await fixture();
    try {
      const manual = createAutomation(db, {
        id: "automation:one-shot", idempotency_namespace: "automation:one-shot", mode: "propose",
        name: "One shot", next_run_at: "2026-06-02T09:59:30.000Z", owner: { kind: "project", project_id: "demo" },
        permission_policy_ref: "project-policy:demo", status: "active", workflow_ref: "workflow:implement@1",
        trigger_created_by: "system", trigger: { type: "manual", config: { target_issue_id: 739 } }
      }, "2026-06-02T09:00:00.000Z");
      const paused = createAutomation(db, {
        id: "automation:paused", idempotency_namespace: "automation:paused", mode: "propose",
        name: "Paused", next_run_at: "2026-06-02T09:59:30.000Z", owner: { kind: "project", project_id: "demo" },
        permission_policy_ref: "project-policy:demo", status: "paused", workflow_ref: "workflow:implement@1",
        trigger_created_by: "system", trigger: { type: "manual", config: { target_issue_id: 740 } }
      }, "2026-06-02T09:00:00.000Z");

      const first = await runDueAutomations({ database: db, now: NOW, executeAutomation: async () => ({ detail: "once" }) });
      const second = await runDueAutomations({ database: db, now: NOW, executeAutomation: async () => { throw new Error("duplicate"); } });

      expect(first).toMatchObject({ executed: 1, scanned: 1 });
      expect(second).toEqual({ deadLettered: 0, executed: 0, failed: 0, scanned: 0, skipped: 0 });
      expect(getAutomation(db, manual.id)?.next_run_at).toBeNull();
      expect(listAutomationRuns(db, manual.id)).toHaveLength(1);
      expect(getAutomation(db, paused.id)?.next_run_at).toBe("2026-06-02T09:59:30.000Z");
      expect(listAutomationRuns(db, paused.id)).toEqual([]);
    } finally { db.close(); }
  });

  test("dead-letters exactly once after the maximum retry budget and surfaces Attention", async () => {
    const db = await fixture();
    try {
      const automation = createFixture(db, "2026-06-02T09:59:30.000Z");
      const fail = async () => { throw new Error("provider unavailable"); };
      await runDueAutomations({ database: db, now: NOW, executeAutomation: fail });
      await runDueAutomations({ database: db, now: new Date("2026-06-02T10:01:00.000Z"), executeAutomation: fail });
      const terminal = await runDueAutomations({ database: db, now: new Date("2026-06-02T10:03:00.000Z"), executeAutomation: fail });
      expect(terminal).toMatchObject({ deadLettered: 1, failed: 1, scanned: 1 });
      expect(listAutomationRuns(db, automation.id)).toMatchObject([{ status: "failed" }]);
      expect(getAutomation(db, automation.id)?.next_run_at).toBe("2026-06-03T09:00:00.000Z");
      expect(listPiGuardianAlerts(db, { alertType: "automation_dead_letter", status: "open" })).toMatchObject([
        { project_id: "demo", severity: "high" }
      ]);
      expect(db.sqlite.query("select event_type from automation_run_events where event_type='automation.run_dead_lettered.v1'").all()).toHaveLength(1);
    } finally { db.close(); }
  });
});

async function fixture(): Promise<RunnerDatabase> { return openDatabase({ stateDir: join(await fixtureRoot(), "state") }); }
async function fixtureRoot(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "automation-scheduler-")); roots.push(root); return root; }

function createFixture(db: RunnerDatabase, nextRunAt: string) {
  return createAutomation(db, {
    id: "automation:weekday-triage", idempotency_namespace: "automation:weekday-triage", mode: "propose",
    name: "Weekday triage", next_run_at: nextRunAt, owner: { kind: "project", project_id: "demo" },
    permission_policy_ref: "project-policy:demo", status: "active", workflow_ref: "workflow:investigate@1",
    trigger_created_by: "system", trigger: { type: "cron", config: { expression: "0 9 * * *", timezone: "UTC" } }
  }, "2026-06-02T09:00:00.000Z");
}

function insertSupervisorCandidate(db: RunnerDatabase): void {
  db.sqlite.run(`insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
    values ('demo', 'demo', '/tmp/demo', 'codex', 0, ?, ?)`, [
    "2026-06-02T09:00:00.000Z",
    "2026-06-02T09:00:00.000Z"
  ]);
  upsertProjectPiPolicy(db, {
    allowed_supervisor_actions_json: ["issue.supervisor_decision"],
    project_id: "demo",
    supervisor_mode: "autonomous"
  });
  db.sqlite.run(`insert into issues (id, project_id, title, status, attempt_count, created_at, updated_at)
    values (912, 'demo', 'stale provider session', 'in_progress', 1, ?, ?)`, [
    "2026-06-02T09:00:00.000Z",
    "2026-06-02T09:45:00.000Z"
  ]);
  db.sqlite.run(`insert into issue_runs
    (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id, started_at, ended_at)
    values ('issue-912-attempt-1', 912, 1, 'in_progress', 'codex', 'thread-912', 'turn-912', ?, '')`, [
    "2026-06-02T09:00:00.000Z"
  ]);
  db.sqlite.run(`insert into agent_sessions
    (session_key, provider, provider_session_id, project_id, issue_id, status, raw_ref, created_at, updated_at)
    values ('codex:thread-912', 'codex', 'thread-912', 'demo', 912, 'running', ?, ?, ?)`, [
    JSON.stringify({ provider_turn_id: "turn-912" }),
    "2026-06-02T09:00:00.000Z",
    "2026-06-02T09:45:00.000Z"
  ]);
  db.sqlite.run(`insert into issue_events (issue_id, type, payload, created_at)
    values (912, 'issue.log', ?, ?)`, [
    JSON.stringify({ raw_payload: "stream disconnected before completion", type: "error" }),
    "2026-06-02T09:45:05.000Z"
  ]);
}
