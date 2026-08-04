import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { runDelegationHeartbeatsOnce, runPiHeartbeatOnce } from "./heartbeatOrchestrator.ts";

const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-bun-heartbeat-memory-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI heartbeat memory signals", () => {
  test("retrieves confirmed project memory and omits disabled candidates", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      insertMemory(db, "active-policy", 0, "Project policy: verify before commit");
      insertMemory(db, "candidate", 1, "Unconfirmed guess should not be used");

      const result = await runPiHeartbeatOnce({ database: db, projectID: "demo", now: new Date("2026-06-02T10:00:00Z") });

      expect(result.signals.memory_items).toEqual([
        expect.objectContaining({
          content: "Project policy: verify before commit",
          id: "active-policy",
          kind: "project_policy",
          reference: "pi_memory_items/active-policy",
          source_id: "259",
          source_type: "issue"
        })
      ]);
      expect(JSON.stringify(result.signals.memory_items)).not.toContain("Unconfirmed guess");

      const stored = db.sqlite.query<{ result_json: string; signals_json: string }, []>(
        "select result_json, signals_json from pi_heartbeat_runs"
      ).get();
      const resultJson = JSON.parse(stored?.result_json ?? "{}");
      const signalsJson = JSON.parse(stored?.signals_json ?? "{}");
      expect(resultJson.signals.memory_items[0]).toMatchObject({ reference: "pi_memory_items/active-policy" });
      expect(signalsJson.memory_items[0]).toMatchObject({ source_type: "issue", source_id: "259" });
    } finally {
      db.close();
    }
  });

  test("injects delegation issue-scope memory before project memory", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      insertIssue(db, 259, "demo");
      insertDelegation(db, "delegation-a", "demo", [259]);
      insertScopedMemory(db, "project-policy", "project", "demo", "Project scoped policy");
      insertScopedMemory(db, "issue-memory", "issue", "259", "Issue scoped acceptance");

      const result = await runDelegationHeartbeatsOnce({
        database: db,
        now: new Date("2026-06-02T10:00:00Z")
      });

      const items = result.runs[0]?.signals.memory_items ?? [];
      expect(items.map((item) => item.id)).toEqual(["issue-memory", "project-policy"]);
      expect(items[0]).toMatchObject({ reference: "pi_memory_items/issue-memory", scope: "issue", scope_id: "259" });
    } finally {
      db.close();
    }
  });
});

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "codex", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertMemory(db: RunnerDatabase, id: string, disabled: number, content: string): void {
  db.sqlite.run(
    `insert into pi_memory_items
      (id, scope, scope_id, kind, content, source_type, source_id, confidence, disabled, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, "project", "demo", "project_policy", content, "issue", "259", "high", disabled,
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertDelegation(db: RunnerDatabase, id: string, projectID: string, issueIDs: number[]): void {
  db.sqlite.run(
    `insert into pi_delegations
      (id, project_id, title, status, intent_json, authorization_json, scope_json, next_heartbeat_at, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, projectID, "Watch scoped issue", "active", "{}", "{}",
      JSON.stringify({ issue_ids: issueIDs, project_id: projectID }), "2026-06-02T09:59:00Z",
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertScopedMemory(db: RunnerDatabase, id: string, scope: string, scopeID: string, content: string): void {
  db.sqlite.run(
    `insert into pi_memory_items
      (id, scope, scope_id, kind, content, source_type, source_id, confidence, disabled, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, scope, scopeID, "project_policy", content, "issue", "259", "high", 0,
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, id: number, projectID: string): void {
  db.sqlite.run(
    `insert into issues (id, project_id, title, status, priority, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [id, projectID, `Issue ${id}`, "todo", 3, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}
