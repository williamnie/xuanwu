import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { diagnoseIssueState } from "./issueStateManager.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI pending verification timeout", () => {
  test("uses project policy timeout without turning a legacy text report into semantic acceptance", async () => {
    const db = await openFixture();
    try {
      insertProjectPolicy(db, 60);
      const timedOut = insertIssue(db, "Timed out by policy", "2026-01-01T00:00:00Z");
      const recent = insertIssue(db, "Still within policy", "2026-01-01T00:30:00Z");
      const verified = insertIssue(db, "Verified pending", "2026-01-01T00:00:00Z");
      insertEvent(db, verified, "issue.verification_report", { summary: "bun test passed", recommendation: "accept" });

      const result = diagnoseIssueState(db, { now: new Date("2026-01-01T01:01:00Z"), projectID: "demo" });
      const byIssue = new Map(result.diagnostics.map((item) => [item.issue_id, item]));

      expect(byIssue.get(timedOut)).toMatchObject({
        code: "pending_verification_timeout",
        recommended_actions: [expect.objectContaining({ operation: "comment" })]
      });
      expect(byIssue.has(recent)).toBe(false);
      expect(byIssue.get(verified)).toMatchObject({
        code: "pending_verification_timeout",
        recommended_actions: [expect.objectContaining({ operation: "comment" })]
      });
    } finally {
      db.close();
    }
  });
});

async function openFixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-verification-timeout-"));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    ["demo", "demo", join(root, "project"), "codex", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  return db;
}

function insertProjectPolicy(db: RunnerDatabase, timeoutMinutes: number): void {
  db.sqlite.run(
    `insert into project_pi_policies (project_id, verification_policy_json, created_at, updated_at)
     values (?, ?, ?, ?)`,
    ["demo", JSON.stringify({ pending_timeout_minutes: timeoutMinutes }), "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, title: string, updatedAt: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at)
     values (?, ?, ?, ?, ?)`,
    ["demo", title, "pending_verification", updatedAt, updatedAt]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing issue id");
  return row.id;
}

function insertEvent(db: RunnerDatabase, issueID: number, type: string, payload: unknown): void {
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, type, JSON.stringify(payload), "2026-01-01T01:00:00Z"]
  );
}
