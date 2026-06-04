import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createPiAction, createPiDelegation, createPiHeartbeatRun } from "../db/repositories/pi.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI Command Center API", () => {
  test("aggregates only P11.01 mode, delegation, approval, and heartbeat card signals", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      insertPiSettings(database, "demo");
      createPiDelegation(database, { project_id: "demo", status: "active", title: "Night window" });
      createPiAction(database, { action_type: "issue.enqueue", id: "act-1", project_id: "demo", status: "pending" });
      createPiHeartbeatRun(database, { id: "hb-1", kind: "project", project_id: "demo", status: "completed" });

      const response = await createDefaultRouter({ database }).handle(new Request(`${BASE_URL}/api/pi/command-center`));
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ mode: "delegated" });
      expect(body.overview).toMatchObject({
        active_delegations: 1,
        autonomous_projects: 1,
        pending_approvals: 1
      });
      expect(body.heartbeat).toMatchObject({
        latest_run: { id: "hb-1", status: "completed" },
        status: "completed"
      });
      expect(body).not.toHaveProperty("projects");
      expect(body).not.toHaveProperty("reports");
      expect(body).not.toHaveProperty("audit_events");
    } finally {
      database.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-command-center-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, auto_run, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, 1, 1, "2026-06-03T09:00:00Z", "2026-06-03T09:00:00Z"]
  );
}

function insertPiSettings(db: RunnerDatabase, projectID: string): void {
  db.sqlite.run(
    `insert into pi_agents (id, name, provider, model_provider, model_id, thinking_level, cwd_policy, tools_json, instructions, enabled, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["agent-1", "PI", "pi-sdk", "openai", "gpt-5.4", "high", "project", "[]", "", 1, "2026-06-03T09:00:00Z", "2026-06-03T09:00:00Z"]
  );
  db.sqlite.run(
    `insert into project_pi_settings (project_id, pi_agent_id, auto_manage, auto_triage, auto_enqueue, notify_on_needs_user, max_actions_per_cycle, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [projectID, "agent-1", 1, 0, 0, 1, 5, "2026-06-03T09:00:00Z", "2026-06-03T09:00:00Z"]
  );
}
