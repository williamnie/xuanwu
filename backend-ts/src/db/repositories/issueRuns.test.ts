import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../database.ts";
import { createIssueRun, ensureOpenIssueRun, updateIssueRuntime, updateOpenIssueRunRuntime } from "./issueRuns.ts";

const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-issue-run-repo-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("issue run repository", () => {
  test("creates attempts and updates only the open run runtime", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const issueId = insertIssue(db, "demo");

      const first = createIssueRun(db, issueId);
      updateOpenIssueRunRuntime(db, issueId, {
        provider: "codex",
        provider_session_id: "thread-1",
        provider_turn_id: "turn-1",
        metadata: { model: "codex-default", cwd: "/tmp/demo" }
      });
      closeRun(db, first.id);
      const second = createIssueRun(db, issueId);
      updateOpenIssueRunRuntime(db, issueId, {
        provider: "codex",
        provider_session_id: "thread-2",
        provider_turn_id: "turn-2"
      });

      expect(allRuns(db, issueId)).toEqual([
        {
          attempt: 1,
          provider_session_id: "thread-1",
          provider_turn_id: "turn-1",
          runtime_metadata_json: "{\"model\":\"codex-default\",\"cwd\":\"/tmp/demo\"}"
        },
        {
          attempt: 2,
          provider_session_id: "thread-2",
          provider_turn_id: "turn-2",
          runtime_metadata_json: "{}"
        }
      ]);
      expect(second.attempt).toBe(2);
    } finally {
      db.close();
    }
  });

  test("ensures one open attempt and mirrors Codex runtime to compatibility fields", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const issueId = insertIssue(db, "demo");

      const first = ensureOpenIssueRun(db, issueId);
      const same = ensureOpenIssueRun(db, issueId);
      updateIssueRuntime(db, issueId, {
        provider: "codex",
        provider_session_id: "thread-codex",
        provider_turn_id: "turn-codex",
        metadata: { source: "turn/start" }
      });

      expect(same.id).toBe(first.id);
      expect(allRuns(db, issueId)).toEqual([{
        attempt: 1,
        provider_session_id: "thread-codex",
        provider_turn_id: "turn-codex",
        runtime_metadata_json: "{\"source\":\"turn/start\"}"
      }]);
      expect(db.sqlite.query<Record<string, unknown>, [number]>(
        "select codex_thread_id, codex_turn_id from issues where id=?"
      ).get(issueId)).toEqual({ codex_thread_id: "thread-codex", codex_turn_id: "turn-codex" });
    } finally {
      db.close();
    }
  });

  test("does not let a late closed attempt overwrite the current issue session", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const issueId = insertIssue(db, "demo");
      const first = createIssueRun(db, issueId);
      updateIssueRuntime(db, issueId, {
        issue_run_id: first.id,
        provider: "codex",
        provider_session_id: "thread-1",
        provider_turn_id: "turn-1"
      });
      closeRun(db, first.id);
      const second = createIssueRun(db, issueId);
      updateIssueRuntime(db, issueId, {
        issue_run_id: second.id,
        provider: "codex",
        provider_session_id: "thread-2",
        provider_turn_id: "turn-2"
      });

      updateIssueRuntime(db, issueId, {
        issue_run_id: first.id,
        provider: "codex",
        provider_session_id: "thread-1-late",
        provider_turn_id: "turn-1-late"
      });

      expect(allRuns(db, issueId)).toEqual([
        expect.objectContaining({ attempt: 1, provider_session_id: "thread-1-late", provider_turn_id: "turn-1-late" }),
        expect.objectContaining({ attempt: 2, provider_session_id: "thread-2", provider_turn_id: "turn-2" })
      ]);
      expect(db.sqlite.query<Record<string, unknown>, [number]>(
        "select codex_thread_id, codex_turn_id from issues where id=?"
      ).get(issueId)).toEqual({ codex_thread_id: "thread-2", codex_turn_id: "turn-2" });
    } finally {
      db.close();
    }
  });
});

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectId: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at)
     values (?, ?, ?, ?, ?)`,
    [projectId, "Runtime", "in_progress", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}

function closeRun(db: RunnerDatabase, id: string): void {
  db.sqlite.run("update issue_runs set ended_at=?, status=? where id=?", ["2026-01-01T00:00:00Z", "done", id]);
}

function allRuns(db: RunnerDatabase, issueId: number): Array<Record<string, unknown>> {
  return db.sqlite.query<Record<string, unknown>, [number]>(
    `select attempt, provider_session_id, provider_turn_id, runtime_metadata_json
     from issue_runs where issue_id=? order by attempt asc`
  ).all(issueId);
}
