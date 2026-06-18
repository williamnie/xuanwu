import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import {
  addPiRunGroupItem,
  createPiNotificationIntent,
  createPiRunGroup,
  listPiNotificationIntents
} from "../db/repositories/pi.ts";
import { runScheduleLayerCycle } from "./piAutoManageScheduler.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI auto-manage digest flush integration", () => {
  test("flushes due run group digests during schedule layer cycles", async () => {
    const db = await openFixtureDatabase();
    try {
      seedAutoManagedProject(db);
      insertIssue(db, 801, "Done issue", "done");
      createPiRunGroup(db, { id: "group-scheduled", project_id: "enabled", expected_issue_count: 1 });
      addPiRunGroupItem(db, {
        enqueue_status: "completed",
        final_issue_status: "done",
        issue_id: 801,
        position: 1,
        run_group_id: "group-scheduled"
      });
      createPiNotificationIntent(db, {
        id: "scheduled-life-801",
        issue_id: 801,
        kind: "issue_done",
        project_id: "enabled",
        run_group_id: "group-scheduled",
        state: "pending",
        target_channel: "feishu"
      });

      const result = await runScheduleLayerCycle({ database: db, runProjectCycle: async () => ({}) });
      const intents = listPiNotificationIntents(db, { runGroupId: "group-scheduled" });

      expect(result.digestFlush).toEqual({ flushed: 1, scanned: 1, skipped: 0 });
      expect(intents.filter((intent) => intent.kind === "digest")).toMatchObject([
        { flush_reason: "completed", flush_sequence: 1, state: "ready" }
      ]);
      expect(intents.find((intent) => intent.id === "scheduled-life-801")).toMatchObject({ state: "aggregated" });
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-auto-digest-flush-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function seedAutoManagedProject(db: RunnerDatabase): void {
  db.sqlite.run(
    "insert into projects (id, name, cwd, auto_run, sort_order, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
    ["enabled", "enabled", "/tmp/enabled", 1, 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  db.sqlite.run("insert into pi_agents (id, name, enabled, created_at, updated_at) values (?, ?, ?, ?, ?)", [
    "pi-default", "pi-default", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"
  ]);
  db.sqlite.run(
    `insert into project_pi_settings
     (project_id, pi_agent_id, auto_manage, max_actions_per_cycle, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    ["enabled", "pi-default", 1, 5, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, id: number, title: string, status: string): void {
  db.sqlite.run(
    "insert into issues (id, project_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
    [id, "enabled", title, status, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}
