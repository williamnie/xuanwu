import { expect, test } from "bun:test";

import { createAgentProfile } from "../db/repositories/agentProfiles.ts";
import { getAutomationExecutionLink } from "../db/repositories/automationExecutionLinks.ts";
import { listAutomationRuns } from "../db/repositories/automations.ts";
import { listStoredEvidence } from "../db/repositories/evidence.ts";
import { listStoredHandoffs } from "../db/repositories/handoffs.ts";

import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { createProjectPiSettings, pausePiHeartbeat, upsertProjectPiPolicy } from "../db/repositories/pi.ts";
import { getIssueAsWork } from "../domain/work/issueAdapter.ts";

import { INVESTIGATE_WORKFLOW_REF } from "../workflows/investigate.ts";
import { createPiAutoManageScheduler } from "./piAutoManageScheduler.ts";

import {
  NOW,
  FixtureProvider,
  FixtureClock,
  cycle,
  fixture,
  createFixture,
  waitUntil
} from "./automationRuntimeTestFixtures.ts";

export function registerAutomationRuntimeSchedulingCases() {
  test("constructs the native executor on the production timer path", async () => {
    const db = await fixture();
    const provider = new FixtureProvider();
    const clock = new FixtureClock();
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
  });

  test("dispatches a registered Workflow through the production composition exactly once", async () => {
    const db = await fixture();
    const provider = new FixtureProvider();
    createAgentProfile(db, {
      id: "provider-default",
      model: "",
      name: "Provider Default",
      provider: provider.id
    });
    db.sqlite.run(
      "update projects set model='codex-default', default_agent_profile_id='provider-default' where id='demo'"
    );
    const automation = createFixture(db, "success", "execute_allowed");
    const first = await cycle(db, provider, NOW);
    const duplicate = await cycle(db, provider, NOW);

    expect(first.automationCore).toMatchObject({ executed: 1, scanned: 1, skipped: 0 });
    expect(duplicate.automationCore).toMatchObject({ executed: 0, scanned: 0 });
    expect(provider.inputs).toHaveLength(1);
    expect(provider.inputs[0]?.prompt).toContain(`Workflow ${INVESTIGATE_WORKFLOW_REF}`);
    expect(provider.inputs[0]?.model).toBe("");

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
  });

  test("maps observe mode to an audited skip without invoking a provider", async () => {
    const db = await fixture();
    const provider = new FixtureProvider();
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
  });

  test("retries a failed dispatch on the same linked Work and Run", async () => {
    const db = await fixture();
    const provider = new FixtureProvider(1);
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
  });

  test("records a deterministic no-op without manufacturing Work when no context changed", async () => {
    const db = await fixture();
    const provider = new FixtureProvider();
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
  });

  test("honors project quiet hours before selecting context or creating Work", async () => {
    const db = await fixture();
    const provider = new FixtureProvider();
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
  });

  test("honors the existing project heartbeat pause control", async () => {
    const db = await fixture();
    const provider = new FixtureProvider();
    const automation = createFixture(db, "paused", "execute_allowed");
    pausePiHeartbeat(db, { reason: "maintenance", scopeId: "demo", scopeType: "project" });

    const result = await cycle(db, provider, NOW);
    const run = listAutomationRuns(db, automation.id)[0]!;

    expect(result.automationCore).toMatchObject({ executed: 0, scanned: 1, skipped: 1 });
    expect(run.summary.detail).toContain("project heartbeat is paused for demo");
    expect(provider.inputs).toHaveLength(0);
    expect(getAutomationExecutionLink(db, run.run_id)).toBeNull();
  });

  test("processes one changed project context once across competing standing orders", async () => {
    const db = await fixture();
    const provider = new FixtureProvider();
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
  });
}
