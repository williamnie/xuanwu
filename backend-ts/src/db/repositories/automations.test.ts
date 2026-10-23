import { describe, expect, test } from "bun:test";
import {
  createAutomation,
  getAutomationTrigger,
  listAutomationRuns,
  recordAutomationRun,
  reviseAutomationTrigger,
  transitionAutomationStatus
} from "./automations.ts";
import { useTestDatabase } from "../../testing/harness.ts";

const fixture = useTestDatabase();
const NOW = "2026-07-17T00:00:00.000Z";

describe("Automation repository", () => {
  test("persists versioned cron config, timezone-normalized next run, status audit, and history", async () => {
    const db = await fixture();
    const created = createAutomation(db, {
      id: "automation:weekday-triage", idempotency_namespace: "automation:weekday-triage", mode: "propose",
      name: "Weekday triage", next_run_at: "2026-07-17T09:00:00+08:00",
      owner: { kind: "project", project_id: "xuanwu" }, permission_policy_ref: "project-policy:xuanwu",
      status: "draft", workflow_ref: "workflow:investigate@1", trigger_created_by: "runner",
      trigger: { type: "cron", config: { expression: "0 9 * * 1-5", timezone: "Asia/Shanghai" } }
    }, NOW);
    expect(created.next_run_at).toBe("2026-07-17T01:00:00.000Z");
    expect(getAutomationTrigger(db, created.id)).toMatchObject({ version: 1, type: "cron", config: { timezone: "Asia/Shanghai" } });

    const active = transitionAutomationStatus(db, created.id, { audit: audit("status-1"), expected_revision: 0, status: "active" });
    const revised = reviseAutomationTrigger(db, active.id, { type: "continuous", config: { poll_interval_seconds: 60 } }, audit("trigger-2"), "2026-07-17T02:00:00Z");
    expect(revised).toMatchObject({ active_trigger_version: 2, revision: 2, status: "active" });
    expect(getAutomationTrigger(db, revised.id, 1)?.type).toBe("cron");
    expect(getAutomationTrigger(db, revised.id)?.type).toBe("continuous");

    recordAutomationRun(db, {
      automation_id: revised.id, completed_at: NOW, created_at: NOW, idempotency_key: "cron:2026-07-17T01:00:00.000Z",
      requested_at: NOW, run_id: "automation-run:weekday-1", status: "succeeded", summary: { items: 1 }, trigger_version: 1
    });
    expect(listAutomationRuns(db, revised.id)).toMatchObject([{ status: "succeeded", trigger_version: 1 }]);
    expect(db.sqlite.query("select event_type, gate_authority from automation_events order by occurred_at, event_id").all()).toEqual([
      { event_type: "automation.status_changed.v1", gate_authority: "deterministic_policy" },
      { event_type: "automation.trigger_revised.v1", gate_authority: "deterministic_policy" }
    ]);
  });

  test("rejects mutations without deterministic permission evidence", async () => {
    const db = await fixture();
    const created = createAutomation(db, input({ type: "manual", config: {} }));
    expect(() => reviseAutomationTrigger(db, created.id, { type: "webhook", config: { event_type: "issue.updated" } }, {
      ...audit("denied"), gate: { authority: "deterministic_policy", decision: "deny", policy_ref: "automation-state:v1" }
    })).toThrow("requires an allowed");
  });
});

function input(trigger: { type: "cron" | "manual" | "webhook" | "continuous"; config: object }) {
  return {
    id: "automation:manual-triage", idempotency_namespace: "automation:manual-triage", mode: "propose" as const,
    name: "Manual triage", owner: { kind: "project" as const, project_id: "xuanwu" },
    permission_policy_ref: "project-policy:xuanwu", status: "draft" as const,
    workflow_ref: "workflow:investigate@1", trigger_created_by: "runner", trigger
  };
}
function audit(event_id: string) { return { actor_id: "runner", actor_kind: "runner" as const, correlation_id: "corr:automation", event_id, gate: { authority: "deterministic_policy" as const, decision: "allow" as const, policy_ref: "automation-state:v1" }, occurred_at: NOW, reason: "test mutation" }; }
