import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listPiMemoryItems } from "../db/repositories/pi.ts";
import { generateFailurePatternMemoryCandidates } from "./failurePatternCandidates.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI failure pattern memory candidates", () => {
  test("does not generate a candidate from one failed issue even with run and session evidence", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const issueID = insertFailedIssue(db, "demo", "thread-single", "provider returned quota exhaustion");
      insertFailedRun(db, issueID, "thread-single", "provider returned quota exhaustion");
      insertFailedSession(db, "demo", issueID, "thread-single", "provider returned quota exhaustion");

      const created = generateFailurePatternMemoryCandidates(db, "demo");

      expect(created).toEqual([]);
      expect(listPiMemoryItems(db, { scope: "project", scopeId: "demo" })).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("creates a disabled failure pattern candidate for repeated failed issue/session sources", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const first = insertFailedIssue(db, "demo", "thread-quota-a", "provider returned quota exhaustion on model a");
      const second = insertFailedIssue(db, "demo", "thread-quota-b", "provider returned quota exhaustion on model b");
      insertFailedSession(db, "demo", first, "thread-quota-a", "quota exhaustion still blocked");
      insertFailedSession(db, "demo", second, "thread-quota-b", "quota exhaustion still blocked");
      insertFailedIssue(db, "demo", "thread-single", "permission denied in local sandbox");

      generateFailurePatternMemoryCandidates(db, "demo");

      const active = listPiMemoryItems(db, { disabled: 0, scope: "project", scopeId: "demo" });
      const candidates = listPiMemoryItems(db, { disabled: 1, scope: "project", scopeId: "demo" });
      const content = JSON.parse(candidates[0]?.content ?? "{}") as Record<string, unknown>;

      expect(active).toEqual([]);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        kind: "failure_pattern",
        source_type: "failure_pattern_scan"
      });
      expect(candidates[0]?.source_id).toContain(`issue:${first}`);
      expect(candidates[0]?.source_id).toContain(`issue:${second}`);
      expect(candidates[0]?.source_id).toContain("session:thread-quota-a");
      expect(content).toMatchObject({
        category: "needs_user",
        match: "quota exhaustion",
        occurrence_count: 2
      });
      expect(content.sources).toEqual([
        expect.objectContaining({ issue_id: first, session_id: "thread-quota-a" }),
        expect.objectContaining({ issue_id: second, session_id: "thread-quota-b" })
      ]);
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-failure-pattern-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "codex", 1, "2026-06-03T09:00:00Z", "2026-06-03T09:00:00Z"]
  );
}

function insertFailedIssue(db: RunnerDatabase, projectID: string, sessionID: string, error: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, error, codex_thread_id, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [projectID, "Failed task", "failed", error, sessionID, "2026-06-03T09:00:00Z", "2026-06-03T09:10:00Z"]
  );
  return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0;
}

function insertFailedRun(db: RunnerDatabase, issueID: number, sessionID: string, error: string): void {
  db.sqlite.run(
    `insert into issue_runs
      (id, issue_id, attempt, status, provider_session_id, started_at, ended_at, error)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [`issue-${issueID}-attempt-1`, issueID, 1, "failed", sessionID,
      "2026-06-03T09:00:00Z", "2026-06-03T09:05:00Z", error]
  );
}

function insertFailedSession(db: RunnerDatabase, projectID: string, issueID: number, sessionID: string, preview: string): void {
  db.sqlite.run(
    `insert into agent_sessions
      (session_key, provider, provider_session_id, project_id, issue_id, title, preview, status, raw_ref, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [`codex:${sessionID}`, "codex", sessionID, projectID, issueID, "Failed session", preview,
      "failed", "{}", "2026-06-03T09:00:00Z", "2026-06-03T09:05:00Z"]
  );
}
