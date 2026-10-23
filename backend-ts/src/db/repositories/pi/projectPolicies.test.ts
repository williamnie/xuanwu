import { describe, expect, test } from "bun:test";
import {
  getProjectPiPolicy,
  getProjectPiSettings,
  readProjectPiPolicy,
  upsertProjectPiPolicy
} from "../pi.ts";
import { useTestDatabase } from "../../../testing/harness.ts";

const openFixtureDatabase = useTestDatabase();

describe("project PI policy repository", () => {
  test("returns safe defaults without persisting when project policy is missing", async () => {
    const db = await openFixtureDatabase();
    expect(readProjectPiPolicy(db, "demo")).toEqual({
      project_id: "demo",
      allowed_actions_json: "[]",
      allowed_mcp_capabilities_json: "[]",
      allowed_skill_intents_json: "[]",
      allowed_supervisor_actions_json: "[\"session.resume_followup\",\"issue.retry_after\",\"issue.retry\",\"issue.state_repair\",\"needs_user.escalate\"]",
      supervisor_cooldown_seconds: 300,
      supervisor_max_recoveries_per_issue: 6,
      supervisor_max_recoveries_per_project_per_hour: 0,
      supervisor_rate_limit_wait_policy: "respect_retry_after",
      timezone: "UTC",
      working_hours_json: "{}",
      quiet_hours_json: "{}",
      retry_policy_json: "{\"enabled\":false,\"max_attempts\":0,\"backoff_minutes\":[]}",
      concurrency_policy_json: "{\"max_parallel_issues\":1,\"max_parallel_pi_cycles\":1}",
      created_at: "",
      updated_at: ""
    });
    expect(getProjectPiPolicy(db, "demo")).toBeNull();
  });

  test("keeps supervisor safety actions configurable without a mode switch", async () => {
    const db = await openFixtureDatabase();
    const policy = upsertProjectPiPolicy(db, {
      allowed_supervisor_actions_json: [],
      project_id: "demo"
    });

    expect(policy).toMatchObject({
      allowed_supervisor_actions_json: "[]"
    });
  });

  test("persists working and quiet hours separately from project PI binding", async () => {
    const db = await openFixtureDatabase();
    const workingHours = { weekdays: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" };
    const quietHours = { daily: [{ start: "22:00", end: "08:00" }] };
    const retryPolicy = { enabled: true, max_attempts: 2, backoff_minutes: [15, 60] };
    const concurrencyPolicy = { max_parallel_issues: 1, max_parallel_pi_cycles: 1 };

    const policy = upsertProjectPiPolicy(db, {
      project_id: "demo",
      timezone: "Asia/Shanghai",
      working_hours_json: workingHours,
      quiet_hours_json: quietHours,
      retry_policy_json: retryPolicy,
      concurrency_policy_json: concurrencyPolicy,
      allowed_actions_json: ["issue.enqueue", "issue.state_repair"],
      allowed_mcp_capabilities_json: ["docs:resource:runbook"],
      allowed_skill_intents_json: ["xuanwu"]
    });

    expect(policy).toMatchObject({ project_id: "demo", timezone: "Asia/Shanghai" });
    expect(JSON.parse(policy.allowed_actions_json)).toEqual(["issue.enqueue", "issue.state_repair"]);
    expect(JSON.parse(policy.allowed_mcp_capabilities_json)).toEqual(["docs:resource:runbook"]);
    expect(JSON.parse(policy.allowed_skill_intents_json)).toEqual(["xuanwu"]);
    expect(JSON.parse(policy.working_hours_json)).toEqual(workingHours);
    expect(JSON.parse(policy.quiet_hours_json)).toEqual(quietHours);
    expect(JSON.parse(policy.retry_policy_json)).toEqual(retryPolicy);
    expect(JSON.parse(policy.concurrency_policy_json)).toEqual(concurrencyPolicy);
    expect(readProjectPiPolicy(db, "demo")).not.toHaveProperty("default_mode");
    expect(getProjectPiSettings(db, "demo")).toBeNull();
  });
});
