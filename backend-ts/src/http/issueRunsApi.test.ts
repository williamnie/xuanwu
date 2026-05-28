import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3018";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-issue-runs-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun issue runs API", () => {
  test("returns an empty run history when no attempts exist", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueId = insertIssue(database, "demo");
      const router = createDefaultRouter({ database });

      const response = await router.handle(new Request(`${BASE_URL}/api/issues/${issueId}/runs`));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("lists issue_runs canonical attempt history by attempt", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueId = insertIssue(database, "demo");
      insertRun(database, issueId, {
        attempt: 2,
        status: "done",
        providerSessionId: "session-2",
        providerTurnId: "turn-2",
        endedAt: "2026-01-03T00:00:00Z"
      });
      insertRun(database, issueId, {
        attempt: 1,
        status: "failed",
        providerSessionId: "session-1",
        providerTurnId: "turn-1",
        endedAt: "2026-01-02T00:00:00Z"
      });

      const router = createDefaultRouter({ database });
      const response = await router.handle(new Request(`${BASE_URL}/api/issues/${issueId}/runs`));
      const runs = await response.json() as Array<Record<string, unknown>>;

      expect(response.status).toBe(200);
      expect(runs.map((run) => run.attempt)).toEqual([1, 2]);
      expect(runs[0]).toMatchObject({
        id: `issue-${issueId}-attempt-1`,
        issue_id: issueId,
        status: "failed",
        provider: "codex",
        provider_session_id: "session-1",
        provider_turn_id: "turn-1",
        exit_reason: "failed"
      });
      expect(runs[1]).toMatchObject({
        id: `issue-${issueId}-attempt-2`,
        issue_id: issueId,
        status: "done",
        provider_session_id: "session-2",
        provider_turn_id: "turn-2",
        exit_reason: "explicit_status_update"
      });
    } finally {
      database.close();
    }
  });
});

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectId: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at)
     values (?, ?, ?, ?, ?)`,
    [projectId, "Runs API", "todo", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}

type RunFixture = {
  attempt: number;
  endedAt: string;
  providerSessionId: string;
  providerTurnId: string;
  status: string;
};

function insertRun(db: RunnerDatabase, issueId: number, run: RunFixture): void {
  db.sqlite.run(
    `insert into issue_runs
      (id, issue_id, attempt, status, provider_session_id, provider_turn_id,
       started_at, ended_at, exit_reason)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `issue-${issueId}-attempt-${run.attempt}`,
      issueId,
      run.attempt,
      run.status,
      run.providerSessionId,
      run.providerTurnId,
      `2026-01-0${run.attempt}T00:00:00Z`,
      run.endedAt,
      run.status === "done" ? "explicit_status_update" : "failed"
    ]
  );
}
