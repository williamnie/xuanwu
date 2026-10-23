import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunnerDatabase } from "../db/database.ts";
import { runPiHeartbeatOnce } from "./heartbeatOrchestrator.ts";
import { createPiMemoryItem } from "../db/repositories/pi.ts";
import { seedMemoryExperience } from "./memoryExperienceTestFixtures.ts";
import { useTestDatabase } from "../testing/harness.ts";

const openFixtureDatabase = useTestDatabase();

describe("PI heartbeat memory signals", () => {

  test("retrieves confirmed project memory and omits disabled candidates", async () => {
    const db = await openFixtureDatabase();
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
