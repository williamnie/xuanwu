import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getAutomationExecutionLink } from "../db/repositories/automationExecutionLinks.ts";
import { createAutomation, listAutomationRuns } from "../db/repositories/automations.ts";
import { listStoredEvidence } from "../db/repositories/evidence.ts";
import { listStoredHandoffs } from "../db/repositories/handoffs.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { getIssueAsWork } from "../domain/work/issueAdapter.ts";
import { runDueAutomations } from "./automationScheduler.ts";
import { createAutomationWorkRunExecutor } from "./automationWorkRunExecutor.ts";

const roots: string[] = [];
const NOW = new Date("2026-07-18T10:00:00.000Z");

afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

describe("P08.04 Automation Work/Run/Evidence executor", () => {
  test("maps a successful dispatch to source-linked Work, Run, Evidence, and ready Handoff exactly once", async () => {
    const db = await fixture();
    try {
      const automation = createFixture(db, "success", "2026-07-18T09:59:30.000Z");
      const executor = createAutomationWorkRunExecutor({ dispatch: async () => ({ detail: "triage complete", outcome: "succeeded" }), workflow_registry: registry() });
      const first = await runDueAutomations({ database: db, executeAutomation: executor, now: NOW });
      expect(first).toMatchObject({ executed: 1, scanned: 1 });
      expect(await runDueAutomations({ database: db, executeAutomation: executor, now: NOW })).toMatchObject({ scanned: 0 });

      const automationRun = listAutomationRuns(db, automation.id)[0]!;
      const link = getAutomationExecutionLink(db, automationRun.run_id)!;
      expect(link).toMatchObject({ automation_id: automation.id, workflow_ref: "workflow:fixture@1" });
      expect(getIssue(db, link.issue_id)).toMatchObject({ status: "pending_verification" });
      expect(listIssueRuns(db, link.issue_id)).toMatchObject([{ provider: "automation", status: "pending_verification" }]);
      expect(getIssueAsWork(db, link.issue_id)?.provenance.origin).toMatchObject({
        authority: "automation_definitions", kind: "automation_trigger", external_id: `${automation.id}/${automationRun.run_id}`
      });
      expect(listStoredEvidence(db, { issue_ids: [link.issue_id], limit: 10 }).items).toMatchObject([{ evidence: { status: "passed", run_id: link.run_id } }]);
      expect(listStoredHandoffs(db, { work_id: link.work_id, limit: 10 }).items).toMatchObject([{ handoff: { status: "ready", run_ids: [link.run_id] } }]);
    } finally { db.close(); }
  });

  test("maps an explicit skip and a retriable failure to terminal Evidence/Handoff without duplicating the Work/Run", async () => {
    const db = await fixture();
    try {
      const skipped = createFixture(db, "skipped", "2026-07-18T09:59:30.000Z");
      const skipExecutor = createAutomationWorkRunExecutor({ dispatch: async () => ({ detail: "approval required", outcome: "skipped" }), workflow_registry: registry() });
      await runDueAutomations({ database: db, executeAutomation: skipExecutor, now: NOW });
      const skipLink = getAutomationExecutionLink(db, listAutomationRuns(db, skipped.id)[0]!.run_id)!;
      expect(getIssue(db, skipLink.issue_id)).toMatchObject({ status: "cancelled" });
      expect(listStoredEvidence(db, { issue_ids: [skipLink.issue_id], limit: 10 }).items[0]?.evidence.status).toBe("blocked");

      const failed = createFixture(db, "failed", "2026-07-18T09:59:30.000Z");
      const failExecutor = createAutomationWorkRunExecutor({ dispatch: async () => { throw new Error("workflow unavailable"); }, workflow_registry: registry() });
      expect(await runDueAutomations({ database: db, executeAutomation: failExecutor, now: NOW })).toMatchObject({ failed: 1, scanned: 1 });
      const failedRun = listAutomationRuns(db, failed.id)[0]!;
      const failLink = getAutomationExecutionLink(db, failedRun.run_id)!;
      expect(failedRun.status).toBe("queued");
      expect(listStoredEvidence(db, { issue_ids: [failLink.issue_id], limit: 10 }).items[0]?.evidence.status).toBe("failed");
      expect(listStoredHandoffs(db, { work_id: failLink.work_id, limit: 10 }).items[0]?.handoff.status).toBe("draft");
    } finally { db.close(); }
  });
});

async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "automation-work-run-"));
  roots.push(root);
  const db = await openDatabase({ stateDir: root });
  db.sqlite.run(`insert into projects (id, name, cwd, provider, created_at, updated_at)
    values ('demo', 'Demo', ?, 'codex', ?, ?)`, [join(root, "repo"), NOW.toISOString(), NOW.toISOString()]);
  return db;
}

function createFixture(db: RunnerDatabase, suffix: string, nextRunAt: string) {
  return createAutomation(db, {
    id: `automation:${suffix}`, idempotency_namespace: `automation:${suffix}`, mode: "propose", name: `Automation ${suffix}`,
    next_run_at: nextRunAt, owner: { kind: "project", project_id: "demo" }, permission_policy_ref: "project-policy:demo",
    status: "active", workflow_ref: "workflow:fixture@1", trigger_created_by: "system",
    trigger: { type: "continuous", config: { poll_interval_seconds: 60 } }
  }, "2026-07-18T09:00:00.000Z");
}

function registry() {
  return {
    resolve: () => ({ ok: true as const, resolution: {
      manifest: {} as never, manifest_ref: "workflow:fixture@1", project_id: "demo",
      project_override_applied: false, source_path: "test", verification_overrides: []
    } })
  };
}
