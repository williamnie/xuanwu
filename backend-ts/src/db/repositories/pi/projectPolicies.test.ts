import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../database.ts";
import {
  getProjectPiPolicy,
  getProjectPiSettings,
  readProjectPiPolicy,
  upsertProjectPiPolicy
} from "../pi.ts";

const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-policy-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("project PI policy repository", () => {
  test("returns safe defaults without persisting when project policy is missing", async () => {
    const db = await openFixtureDatabase();
    try {
      expect(readProjectPiPolicy(db, "demo")).toEqual({
        project_id: "demo",
        allowed_actions_json: "[]",
        allowed_mcp_capabilities_json: "[]",
        allowed_skill_intents_json: "[]",
        allowed_supervisor_actions_json: "[]",
        default_mode: "manual",
        supervisor_cooldown_seconds: 300,
        supervisor_max_recoveries_per_issue: 2,
        supervisor_max_recoveries_per_project_per_hour: 10,
        supervisor_mode: "propose_only",
        supervisor_rate_limit_wait_policy: "respect_retry_after",
        timezone: "UTC",
        working_hours_json: "{}",
        quiet_hours_json: "{}",
        retry_policy_json: "{\"enabled\":false,\"max_attempts\":0,\"backoff_minutes\":[]}",
        concurrency_policy_json: "{\"max_parallel_issues\":1,\"max_parallel_pi_cycles\":1}",
        verification_policy_json: "{\"pending_timeout_minutes\":1440,\"on_timeout\":\"escalate\",\"evidence_required\":true}",
        created_at: "",
        updated_at: ""
      });
      expect(getProjectPiPolicy(db, "demo")).toBeNull();
    } finally {
      db.close();
    }
  });

  test("persists default mode plus working and quiet hours separately from project PI settings", async () => {
    const db = await openFixtureDatabase();
    try {
      const workingHours = { weekdays: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" };
      const quietHours = { daily: [{ start: "22:00", end: "08:00" }] };
      const retryPolicy = { enabled: true, max_attempts: 2, backoff_minutes: [15, 60] };
      const concurrencyPolicy = { max_parallel_issues: 1, max_parallel_pi_cycles: 1 };
      const verificationPolicy = { pending_timeout_minutes: 90, on_timeout: "request_verifier", evidence_required: false };

      const policy = upsertProjectPiPolicy(db, {
        project_id: "demo",
        default_mode: "delegated",
        timezone: "Asia/Shanghai",
        working_hours_json: workingHours,
        quiet_hours_json: quietHours,
        retry_policy_json: retryPolicy,
        concurrency_policy_json: concurrencyPolicy,
        allowed_actions_json: ["issue.enqueue", "issue.state_repair"],
        allowed_mcp_capabilities_json: ["docs:resource:runbook"],
        allowed_skill_intents_json: ["codex-issue-runner"],
        verification_policy_json: verificationPolicy
      });

      expect(policy).toMatchObject({ project_id: "demo", default_mode: "delegated", timezone: "Asia/Shanghai" });
      expect(JSON.parse(policy.allowed_actions_json)).toEqual(["issue.enqueue", "issue.state_repair"]);
      expect(JSON.parse(policy.allowed_mcp_capabilities_json)).toEqual(["docs:resource:runbook"]);
      expect(JSON.parse(policy.allowed_skill_intents_json)).toEqual(["codex-issue-runner"]);
      expect(JSON.parse(policy.working_hours_json)).toEqual(workingHours);
      expect(JSON.parse(policy.quiet_hours_json)).toEqual(quietHours);
      expect(JSON.parse(policy.retry_policy_json)).toEqual(retryPolicy);
      expect(JSON.parse(policy.concurrency_policy_json)).toEqual(concurrencyPolicy);
      expect(JSON.parse(policy.verification_policy_json)).toEqual(verificationPolicy);
      expect(readProjectPiPolicy(db, "demo")).toMatchObject({ default_mode: "delegated" });
      expect(getProjectPiSettings(db, "demo")).toBeNull();
    } finally {
      db.close();
    }
  });
});
