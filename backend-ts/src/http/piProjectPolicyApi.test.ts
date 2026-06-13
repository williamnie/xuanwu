import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI project policy API", () => {
  test("reads defaults and upserts project policy through HTTP", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const router = createDefaultRouter({ database });

      const initial = await router.handle(new Request(`${BASE_URL}/api/projects/demo/pi-policy`));
      const patched = await request(router, "/api/projects/demo/pi-policy", "PATCH", {
        allowed_actions: ["issue.enqueue", "issue.state_repair"],
        allowed_mcp_capabilities: ["docs:resource:runbook", "docs:tool:search"],
        allowed_skill_intents: ["codex-issue-runner", "verification-before-completion"],
        allowed_supervisor_actions: ["session.resume_followup", "issue.retry_after"],
        concurrency_policy: { max_parallel_issues: 1, max_parallel_pi_cycles: 1 },
        default_mode: "delegated",
        quiet_hours: { daily: [{ end: "08:00", start: "22:00" }] },
        retry_policy: { enabled: true, max_attempts: 2, backoff_minutes: [15, 60] },
        supervisor_cooldown_seconds: 900,
        supervisor_max_recoveries_per_issue: 3,
        supervisor_max_recoveries_per_project_per_hour: 12,
        supervisor_mode: "autonomous",
        supervisor_rate_limit_wait_policy: "default_cooldown",
        timezone: "Asia/Shanghai",
        verification_policy: { evidence_required: true, on_timeout: "request_verifier", pending_timeout_minutes: 90 },
        working_hours: { end: "18:00", start: "09:00", weekdays: [1, 2, 3, 4, 5] }
      });
      const readBack = await router.handle(new Request(`${BASE_URL}/api/projects/demo/pi-policy`));

      expect(initial.status).toBe(200);
      expect(await initial.json()).toMatchObject({
        default_mode: "manual",
        project_id: "demo",
        supervisor_mode: "watchdog",
        timezone: "UTC"
      });
      expect(patched.status).toBe(200);
      const body = await patched.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        default_mode: "delegated",
        project_id: "demo",
        supervisor_cooldown_seconds: 900,
        supervisor_max_recoveries_per_issue: 3,
        supervisor_max_recoveries_per_project_per_hour: 12,
        supervisor_mode: "autonomous",
        supervisor_rate_limit_wait_policy: "default_cooldown",
        timezone: "Asia/Shanghai"
      });
      expect(JSON.parse(String(body.allowed_actions_json))).toEqual(["issue.enqueue", "issue.state_repair"]);
      expect(JSON.parse(String(body.allowed_mcp_capabilities_json))).toEqual(["docs:resource:runbook", "docs:tool:search"]);
      expect(JSON.parse(String(body.allowed_skill_intents_json))).toEqual(["codex-issue-runner", "verification-before-completion"]);
      expect(JSON.parse(String(body.allowed_supervisor_actions_json))).toEqual(["session.resume_followup", "issue.retry_after"]);
      expect(JSON.parse(String(body.working_hours_json))).toEqual({ end: "18:00", start: "09:00", weekdays: [1, 2, 3, 4, 5] });
      expect(JSON.parse(String(body.quiet_hours_json))).toEqual({ daily: [{ end: "08:00", start: "22:00" }] });
      expect(JSON.parse(String(body.retry_policy_json))).toEqual({ enabled: true, max_attempts: 2, backoff_minutes: [15, 60] });
      expect(JSON.parse(String(body.concurrency_policy_json))).toEqual({ max_parallel_issues: 1, max_parallel_pi_cycles: 1 });
      expect(JSON.parse(String(body.verification_policy_json))).toEqual({ evidence_required: true, on_timeout: "request_verifier", pending_timeout_minutes: 90 });
      expect(await readBack.json()).toMatchObject(body);
    } finally {
      database.close();
    }
  });

  test("returns clear policy errors for missing projects and invalid JSON", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const router = createDefaultRouter({ database });

      const missing = await router.handle(new Request(`${BASE_URL}/api/projects/missing/pi-policy`));
      const invalidJson = await router.handle(new Request(`${BASE_URL}/api/projects/demo/pi-policy`, {
        body: "{bad-json",
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }));

      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ message: "资源不存在" });
      expect(invalidJson.status).toBe(400);
      expect(await invalidJson.json()).toEqual({ message: "请求体不是合法 JSON" });
    } finally {
      database.close();
    }
  });

  test("validates policy payload before persistence", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const router = createDefaultRouter({ database });

      const invalidMode = await request(router, "/api/projects/demo/pi-policy", "PATCH", {
        default_mode: "root"
      });
      const invalidRetry = await request(router, "/api/projects/demo/pi-policy", "PATCH", {
        retry_policy: "not-json"
      });
      const invalidVerification = await request(router, "/api/projects/demo/pi-policy", "PATCH", {
        verification_policy: "not-json"
      });
      const invalidAction = await request(router, "/api/projects/demo/pi-policy", "PATCH", {
        allowed_actions: ["bad action"]
      });
      const invalidSkill = await request(router, "/api/projects/demo/pi-policy", "PATCH", {
        allowed_skill_intents: ["bad skill"]
      });
      const invalidMcp = await request(router, "/api/projects/demo/pi-policy", "PATCH", {
        allowed_mcp_capabilities: ["bad mcp"]
      });
      const invalidSupervisorMode = await request(router, "/api/projects/demo/pi-policy", "PATCH", {
        supervisor_mode: "root"
      });
      const invalidSupervisorAction = await request(router, "/api/projects/demo/pi-policy", "PATCH", {
        allowed_supervisor_actions: ["bad action"]
      });
      const invalidSupervisorWait = await request(router, "/api/projects/demo/pi-policy", "PATCH", {
        supervisor_rate_limit_wait_policy: "ignore"
      });

      expect(invalidMode.status).toBe(400);
      expect(await invalidMode.json()).toEqual({ message: "default_mode 不合法" });
      expect(invalidRetry.status).toBe(400);
      expect(await invalidRetry.json()).toEqual({ message: "retry_policy 必须是合法 JSON object" });
      expect(invalidVerification.status).toBe(400);
      expect(await invalidVerification.json()).toEqual({ message: "verification_policy 必须是合法 JSON object" });
      expect(invalidAction.status).toBe(400);
      expect(await invalidAction.json()).toEqual({ message: "allowed_actions id 不合法: bad action" });
      expect(invalidSkill.status).toBe(400);
      expect(await invalidSkill.json()).toEqual({ message: "skill id 不合法: bad skill" });
      expect(invalidMcp.status).toBe(400);
      expect(await invalidMcp.json()).toEqual({ message: "MCP capability id 不合法: bad mcp" });
      expect(invalidSupervisorMode.status).toBe(400);
      expect(await invalidSupervisorMode.json()).toEqual({ message: "supervisor_mode 不合法" });
      expect(invalidSupervisorAction.status).toBe(400);
      expect(await invalidSupervisorAction.json()).toEqual({ message: "allowed_supervisor_actions id 不合法: bad action" });
      expect(invalidSupervisorWait.status).toBe(400);
      expect(await invalidSupervisorWait.json()).toEqual({ message: "supervisor_rate_limit_wait_policy 不合法" });
    } finally {
      database.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-policy-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

async function request(router: ReturnType<typeof createDefaultRouter>, path: string, method: string, body: Record<string, unknown>) {
  return router.handle(new Request(`${BASE_URL}${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method
  }));
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, auto_run, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, 1, 1, "2026-06-03T09:00:00Z", "2026-06-03T09:00:00Z"]
  );
}
