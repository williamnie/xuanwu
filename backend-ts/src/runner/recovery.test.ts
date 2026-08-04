import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { recoverInProgressIssues } from "./recovery.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("startup reconciliation delegates recovery to PI", () => {
  test("signals PI instead of autonomously resuming a live Provider Session", async () => {
    const db = await fixture();
    try {
      const issueID = insertIssue(db, "in_progress", "thread-live");
      insertRun(db, issueID, { session: "thread-live" });
      insertSession(db, issueID, "thread-live", "disconnected");

      const result = await recoverInProgressIssues({ database: db });

      expect(result).toEqual({ reconciled: 0, requeued: 0, signaled: 1 });
      expect(getIssue(db, issueID)?.status).toBe("in_progress");
      expect(listIssueRuns(db, issueID)[0]?.ended_at).toBe("");
      expect(eventTypes(db, issueID)).toContain("issue.recovery_signal.v1");
      expect(eventPayload(db, issueID, "issue.recovery_signal.v1")).toMatchObject({
        provider_session_id: "thread-live",
        required_action: expect.stringContaining("PI must read")
      });
    } finally {
      db.close();
    }
  });

  test("reconciles a terminal Session into a terminal Run and requests PI acceptance", async () => {
    const db = await fixture();
    try {
      const issueID = insertIssue(db, "in_progress", "thread-done");
      insertRun(db, issueID, { session: "thread-done" });
      insertSession(db, issueID, "thread-done", "completed");

      const result = await recoverInProgressIssues({ database: db });

      expect(result).toEqual({ reconciled: 1, requeued: 0, signaled: 0 });
      expect(getIssue(db, issueID)?.status).toBe("in_progress");
      expect(listIssueRuns(db, issueID)[0]).toMatchObject({ status: "succeeded" });
      expect(listIssueRuns(db, issueID)[0]?.ended_at).not.toBe("");
      expect(eventTypes(db, issueID)).toEqual(expect.arrayContaining([
        "issue.pi_acceptance_requested.v1",
        "issue.recovery_terminal_reconciled.v1"
      ]));
    } finally {
      db.close();
    }
  });

  test("only requeues a claim when no Provider Session was ever created", async () => {
    const db = await fixture();
    try {
      const issueID = insertIssue(db, "in_progress", "");
      insertRun(db, issueID, {});

      const result = await recoverInProgressIssues({ database: db });

      expect(result).toEqual({ reconciled: 0, requeued: 1, signaled: 0 });
      expect(getIssue(db, issueID)?.status).toBe("todo");
      expect(eventTypes(db, issueID)).toContain("issue.recovery_requeued.v1");
    } finally {
      db.close();
    }
  });
});

async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "runner-pi-recovery-"));
  roots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, created_at, updated_at)
     values ('demo', 'demo', ?, 'codex', ?, ?)`,
    [root, "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z"]
  );
  return db;
}

function insertIssue(db: RunnerDatabase, status: string, session: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, codex_thread_id, created_at, updated_at)
     values ('demo', 'recover', ?, ?, ?, ?)`,
    [status, session, "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z"]
  );
  return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()!.id;
}

function insertRun(db: RunnerDatabase, issueID: number, input: { session?: string }): void {
  db.sqlite.run(
    `insert into issue_runs
      (id, issue_id, attempt, status, provider, provider_session_id, started_at)
     values (?, ?, 1, 'in_progress', 'codex', ?, ?)`,
    [`issue-${issueID}-attempt-1`, issueID, input.session ?? "", "2026-08-01T00:00:00Z"]
  );
}

function insertSession(db: RunnerDatabase, issueID: number, session: string, status: string): void {
  db.sqlite.run(
    `insert into agent_sessions
      (session_key, provider, provider_session_id, project_id, issue_id, status, raw_ref, created_at, updated_at)
     values (?, 'codex', ?, 'demo', ?, ?, '{}', ?, ?)`,
    [`codex:${session}`, session, issueID, status, "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z"]
  );
}

function eventTypes(db: RunnerDatabase, issueID: number): string[] {
  return db.sqlite.query<{ type: string }, [number]>(
    "select type from issue_events where issue_id=? order by id"
  ).all(issueID).map((event) => event.type);
}

function eventPayload(db: RunnerDatabase, issueID: number, type: string): Record<string, unknown> {
  const row = db.sqlite.query<{ payload: string }, [number, string]>(
    "select payload from issue_events where issue_id=? and type=? order by id desc limit 1"
  ).get(issueID, type);
  return row ? JSON.parse(row.payload) as Record<string, unknown> : {};
}
