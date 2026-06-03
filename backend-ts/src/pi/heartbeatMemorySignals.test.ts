import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { runPiHeartbeatOnce } from "./heartbeatOrchestrator.ts";

const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-heartbeat-memory-"));
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
        expect.objectContaining({ content: "Project policy: verify before commit", kind: "project_policy" })
      ]);
      expect(JSON.stringify(result.signals.memory_items)).not.toContain("Unconfirmed guess");
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
      (id, scope, scope_id, kind, content, confidence, disabled, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, "project", "demo", "project_policy", content, "high", disabled,
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}
