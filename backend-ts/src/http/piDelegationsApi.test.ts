import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getPiDelegation } from "../db/repositories/pi.ts";
import { createDefaultRouter, createRequestHandler } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI delegations API", () => {
  test("creates, lists, pauses, and resumes authorization windows", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const router = createDefaultRouter({ database });

      const created = await request(router, "/api/pi/delegations", "POST", {
        authorization: {
          allowed_actions: ["issue.enqueue"],
          allowed_mcp_capabilities: ["docs:resource:runbook"],
          allowed_skill_intents: ["codex-issue-runner"],
          audit_source: "api-test",
          expires_at: "2026-06-04T08:00:00Z",
          forbidden_actions: ["session.steer"],
          mode: "delegated",
          scope: { project_id: "demo" },
          starts_at: "2026-06-03T20:00:00Z"
        },
        intent: { goal: "clear failed issues overnight" },
        next_heartbeat_at: "2026-06-03T21:00:00Z",
        project_id: "demo",
        title: "Night autonomous window"
      });
      const body = await created.json() as Record<string, unknown>;
      const id = String(body.id);
      const listed = await router.handle(new Request(`${BASE_URL}/api/pi/delegations?project_id=demo&status=active`));
      const paused = await request(router, `/api/pi/delegations/${id}/pause`, "POST", {});
      const resumed = await request(router, `/api/pi/delegations/${id}/resume`, "POST", {});

      expect(created.status).toBe(201);
      expect(body).toMatchObject({
        allowed_actions_json: "[\"issue.enqueue\"]",
        allowed_mcp_capabilities_json: "[\"docs:resource:runbook\"]",
        allowed_skill_intents_json: "[\"codex-issue-runner\"]",
        audit_source: "api-test",
        expires_at: "2026-06-04T08:00:00Z",
        forbidden_actions_json: "[\"session.steer\"]",
        project_id: "demo",
        scope_json: "{\"project_id\":\"demo\"}",
        starts_at: "2026-06-03T20:00:00Z",
        status: "active",
        title: "Night autonomous window"
      });
      expect(String(body.authorization_json)).toContain("issue.enqueue");
      expect((await listed.json() as Array<Record<string, unknown>>).map((item) => item.id)).toEqual([id]);
      expect(await paused.json()).toMatchObject({ id, status: "paused" });
      expect(await resumed.json()).toMatchObject({ id, status: "active" });
      expect(getPiDelegation(database, id)).toMatchObject({ id, status: "active" });
    } finally {
      database.close();
    }
  });

  test("updates and expires persisted delegation authorizations", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const router = createDefaultRouter({ database });
      const created = await request(router, "/api/pi/delegations", "POST", {
        authorization: {
          allowed_actions: ["issue.enqueue"],
          expires_at: "2026-06-04T08:00:00Z",
          mode: "delegated",
          scope: { issue_ids: [101, 102], project_id: "demo" },
          starts_at: "2026-06-03T20:00:00Z"
        },
        project_id: "demo",
        title: "Tonight issues"
      });
      const createdBody = await created.json() as Record<string, unknown>;
      const id = String(createdBody.id);

      expect(created.status).toBe(201);
      expect(createdBody).toMatchObject({
        expires_at: "2026-06-04T08:00:00Z",
        scope_json: "{\"issue_ids\":[101,102],\"project_id\":\"demo\"}",
        starts_at: "2026-06-03T20:00:00Z",
        status: "active"
      });

      const patched = await request(router, `/api/pi/delegations/${id}`, "PATCH", {
        allowed_actions: ["issue.enqueue", "issue.state_repair"],
        allowed_mcp_capabilities: ["docs:resource:runbook", "docs:tool:search"],
        allowed_skill_intents: ["codex-issue-runner", "verification-before-completion"],
        audit_source: "user",
        expires_at: "2026-06-04T09:00:00Z",
        forbidden_actions: ["session.steer"],
        scope: { issue_ids: [101, 102, 103], project_id: "demo" },
        title: "Tonight selected issues"
      });
      const expired = await request(router, `/api/pi/delegations/${id}/expire`, "POST", {});
      const detail = await router.handle(new Request(`${BASE_URL}/api/pi/delegations/${id}`));

      expect(patched.status).toBe(200);
      expect(await patched.json()).toMatchObject({
        allowed_actions_json: "[\"issue.enqueue\",\"issue.state_repair\"]",
        allowed_mcp_capabilities_json: "[\"docs:resource:runbook\",\"docs:tool:search\"]",
        allowed_skill_intents_json: "[\"codex-issue-runner\",\"verification-before-completion\"]",
        audit_source: "user",
        expires_at: "2026-06-04T09:00:00Z",
        forbidden_actions_json: "[\"session.steer\"]",
        scope_json: "{\"issue_ids\":[101,102,103],\"project_id\":\"demo\"}",
        status: "active",
        title: "Tonight selected issues"
      });
      expect(expired.status).toBe(200);
      expect(await expired.json()).toMatchObject({ id, status: "expired" });
      expect(await detail.json()).toMatchObject({ id, status: "expired" });
      expect(getPiDelegation(database, id)).toMatchObject({ id, status: "expired" });
    } finally {
      database.close();
    }
  });

  test("returns clear errors for unauthorized and invalid delegation requests", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const router = createDefaultRouter({ database });
      const protectedHandler = createRequestHandler(router, "secret-token");

      const unauthorized = await protectedHandler(new Request(`${BASE_URL}/api/pi/delegations`));
      const missingProject = await request(router, "/api/pi/delegations", "POST", {
        authorization: { mode: "delegated" },
        title: "No project"
      });
      const invalidStatus = await request(router, "/api/pi/delegations", "POST", {
        authorization: { mode: "delegated", scope: { project_id: "demo" } },
        project_id: "demo",
        status: "archived"
      });
      const invalidAuthorization = await request(router, "/api/pi/delegations", "POST", {
        authorization: "{not-json",
        project_id: "demo"
      });
      const invalidSkill = await request(router, "/api/pi/delegations", "POST", {
        allowed_skill_intents: ["bad skill"],
        project_id: "demo"
      });

      expect(unauthorized.status).toBe(401);
      expect(await unauthorized.json()).toEqual({ message: "unauthorized" });
      expect(missingProject.status).toBe(400);
      expect(await missingProject.json()).toEqual({ message: "project_id 不能为空" });
      expect(invalidStatus.status).toBe(400);
      expect(await invalidStatus.json()).toEqual({ message: "unsupported PI delegation status: archived" });
      expect(invalidAuthorization.status).toBe(400);
      expect(await invalidAuthorization.json()).toEqual({ message: "authorization 必须是合法 JSON" });
      expect(invalidSkill.status).toBe(400);
      expect(await invalidSkill.json()).toEqual({ message: "skill id 不合法: bad skill" });
    } finally {
      database.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-delegations-api-"));
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
