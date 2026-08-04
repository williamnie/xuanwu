import { describe, expect, test } from "bun:test";
import {
  applyAutomationStatusCommand,
  normalizeTimestamp,
  validateVersionedAutomationTrigger,
  type AutomationDefinition,
  type AutomationAudit
} from "./contracts.ts";

const NOW = "2026-07-17T00:00:00.000Z";

describe("unified Automation contracts", () => {
  test("validates cron, manual, webhook, and continuous trigger fixtures", () => {
    expect(validateVersionedAutomationTrigger(trigger({ type: "cron", config: {
      expression: "0 9 * * 1-5", timezone: "Asia/Shanghai"
    } }))).toEqual([]);
    expect(validateVersionedAutomationTrigger(trigger({ type: "manual", config: {} }))).toEqual([]);
    expect(validateVersionedAutomationTrigger(trigger({ type: "webhook", config: {
      event_type: "issue.updated", secret_ref: "secret:github-webhook"
    } }))).toEqual([]);
    expect(validateVersionedAutomationTrigger(trigger({ type: "continuous", config: {
      poll_interval_seconds: 30
    } }))).toEqual([]);
    expect(validateVersionedAutomationTrigger(trigger({ type: "cron", config: {
      expression: "* * * * *", timezone: "Not/AZone"
    } }))).toContain("cron timezone must be an IANA timezone");
  });

  test("normalizes timezone-offset next runs to UTC without losing cron timezone", () => {
    expect(normalizeTimestamp("2026-07-17T09:00:00+08:00")).toBe("2026-07-17T01:00:00.000Z");
  });

  test("requires an auditable deterministic or approved status transition", () => {
    const active = applyAutomationStatusCommand(definition(), {
      audit: audit(), expected_revision: 0, status: "active"
    });
    expect(active).toMatchObject({ revision: 1, status: "active" });
    expect(() => applyAutomationStatusCommand(definition(), {
      audit: { ...audit(), gate: { ...audit().gate, decision: "ask" } }, expected_revision: 0, status: "active"
    })).toThrow("allow gate");
    expect(() => applyAutomationStatusCommand(definition(), {
      audit: { ...audit(), gate: { ...audit().gate, authority: "human_approval" } }, expected_revision: 1, status: "active"
    })).toThrow("revision conflict");
  });
});

function definition(): AutomationDefinition {
  return {
    active_trigger_version: 1, created_at: NOW, id: "automation:weekday-triage", idempotency_namespace: "automation:weekday-triage",
    mode: "propose", name: "Weekday triage", next_run_at: "2026-07-17T01:00:00.000Z",
    owner: { kind: "project", project_id: "xuanwu" }, permission_policy_ref: "project-policy:xuanwu",
    revision: 0, status: "draft", updated_at: NOW, workflow_ref: "workflow:investigate@1"
  };
}

function trigger<T extends { type: "cron" | "manual" | "webhook" | "continuous"; config: object }>(item: T) {
  return { ...item, automation_id: "automation:weekday-triage" as const, created_at: NOW, created_by: "runner", version: 1 };
}

function audit(): AutomationAudit {
  return {
    actor_id: "runner", actor_kind: "runner", correlation_id: "corr:weekday-triage", event_id: "automation-event:1",
    gate: { authority: "deterministic_policy", decision: "allow", policy_ref: "automation-state:v1" }, occurred_at: NOW,
    reason: "operator enabled automation"
  };
}
