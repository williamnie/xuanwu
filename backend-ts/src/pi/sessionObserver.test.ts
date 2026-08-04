import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listProjectSessionProgress, observeSessionProgress } from "./sessionObserver.ts";

const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-bun-session-observer-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("session progress observer", () => {
  test("summarizes active, done, and error sessions without long logs", async () => {
    const db = await openFixtureDatabase();
    const longLog = "line ".repeat(120);
    try {
      insertProject(db, "demo");
      const active = insertIssue(db, "demo", "in_progress", "Active task", 1);
      const done = insertIssue(db, "demo", "done", "Done task", 2);
      const error = insertIssue(db, "demo", "failed", "Error task", 3);
      insertSession(db, active, "thread-active", "running", 4);
      insertSession(db, done, "thread-done", "completed", 5);
      insertSession(db, error, "thread-error", "failed", 6);
      insertRun(db, active, "thread-active", "in_progress", 1);
      insertRun(db, done, "thread-done", "done", 2, "2026-01-02T00:30:00Z");
      insertRun(db, error, "thread-error", "failed", 3, "2026-01-03T00:30:00Z", "AUTH_TOKEN=secret");
      insertIssueLog(db, active, { type: "text", text: `working ${longLog}` }, 4);
      insertIssueLog(db, error, { type: "error", error: `CODEX_API_KEY=secret failed ${longLog}` }, 6);

      const activeSummary = observeSessionProgress(db, "codex:thread-active");
      const activeSummaryByProviderID = observeSessionProgress(db, "thread-active");
      const doneSummary = observeSessionProgress(db, "codex:thread-done");
      const errorSummary = observeSessionProgress(db, "codex:thread-error");

      expect(activeSummary).toMatchObject({ progress_state: "active", session_key: "codex:thread-active" });
      expect(activeSummaryByProviderID).toEqual(activeSummary);
      expect(doneSummary).toMatchObject({ progress_state: "done", session_key: "codex:thread-done" });
      expect(errorSummary).toMatchObject({ progress_state: "error", session_key: "codex:thread-error" });
      expect(JSON.stringify(activeSummary)).not.toContain(longLog);
      expect(JSON.stringify(errorSummary)).not.toContain("secret");
      expect(errorSummary.summary).toContain("[redacted]");
      expect(activeSummary.recent_events[0]?.summary.length ?? 0).toBeLessThanOrEqual(180);
      expect(listProjectSessionProgress(db, "demo").map((item) => item.progress_state).sort()).toEqual([
        "active", "done", "error"
      ]);
    } finally {
      db.close();
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

function insertIssue(db: RunnerDatabase, projectID: string, status: string, title: string, day: number): number {
  const timestamp = timestampForDay(day);
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at)
     values (?, ?, ?, ?, ?)`,
    [projectID, title, status, timestamp, timestamp]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing issue id");
  return row.id;
}

function insertSession(db: RunnerDatabase, issueID: number, sessionID: string, status: string, day: number): void {
  db.sqlite.run(
    `insert into agent_sessions
      (session_key, provider, provider_session_id, project_id, issue_id, title, status, raw_ref, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [`codex:${sessionID}`, "codex", sessionID, "demo", issueID, sessionID, status, "{}",
      "2026-01-01T00:00:00Z", timestampForDay(day)]
  );
}

function insertRun(
  db: RunnerDatabase,
  issueID: number,
  sessionID: string,
  status: string,
  day: number,
  endedAt = "",
  error = ""
): void {
  db.sqlite.run(
    `insert into issue_runs
      (id, issue_id, attempt, status, provider, provider_session_id, started_at, ended_at, error)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [`issue-${issueID}-attempt-1`, issueID, 1, status, "codex", sessionID, timestampForDay(day), endedAt, error]
  );
}

function insertIssueLog(db: RunnerDatabase, issueID: number, payload: Record<string, unknown>, day: number): void {
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, "issue.log", JSON.stringify(payload), timestampForDay(day)]
  );
}

function timestampForDay(day: number): string {
  return `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`;
}
