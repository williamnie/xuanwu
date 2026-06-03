import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { createPiAction, listPiActionEvents } from "../db/repositories/pi.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI state repair executor API", () => {
  test("executes approved move_status repairs and leaves audit records", async () => {
    const db = await openFixture();
    try {
      const issueID = insertIssue(db);
      createPiAction(db, {
        action_type: "issue.state_repair",
        gate_decision: "ask",
        id: "repair-move",
        issue_id: issueID,
        payload_json: JSON.stringify({
          diagnosis_code: "done_missing_verification_evidence",
          issue_id: issueID,
          operation: "move_status",
          patch: { status: "pending_verification" }
        }),
        project_id: "demo",
        status: "approved"
      });

      const response = await createDefaultRouter({ database: db }).handle(
        new Request(`${BASE_URL}/api/pi/actions/repair-move/execute`, { method: "POST" })
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: "repair-move", status: "completed" });
      expect(getIssue(db, issueID)).toMatchObject({ status: "pending_verification" });
      expect(listIssueEvents(db, issueID).map((event) => event.type)).toEqual([
        "issue.status_changed", "issue.state_manager_repair"
      ]);
      expect(listPiActionEvents(db, { actionId: "repair-move" }).map((event) => event.event_type)).toEqual([
        "execution_started", "execution_result"
      ]);
    } finally {
      db.close();
    }
  });
});

async function openFixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-state-repair-api-"));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    ["demo", "demo", join(root, "project"), "codex", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  return db;
}

function insertIssue(db: RunnerDatabase): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at)
     values (?, ?, ?, ?, ?)`,
    ["demo", "Weak done", "done", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing issue id");
  return row.id;
}
