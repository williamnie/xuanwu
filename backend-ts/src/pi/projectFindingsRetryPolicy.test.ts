import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { scanProjectFindings } from "./projectFindings.ts";

const tempRoots: string[] = [];
const NOW = new Date("2026-01-01T01:00:00Z");

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI failed retry policy findings", () => {
  test("applies retry policy only after structured retry state is present", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      insertProjectRetryPolicy(db, { enabled: true, max_attempts: 2, backoff_minutes: [30] });
      const ready = insertIssue(db, { attemptCount: 1, autoRetryNextAt: "2026-01-01T00:30:00Z", error: "network error", title: "Ready", updatedAt: "2026-01-01T00:00:00Z" });
      const cooling = insertIssue(db, { attemptCount: 1, autoRetryNextAt: "2026-01-01T01:15:00Z", error: "network error", title: "Cooling", updatedAt: "2026-01-01T00:45:00Z" });
      const maxed = insertIssue(db, { attemptCount: 2, autoRetryNextAt: "2026-01-01T00:30:00Z", error: "unexpected eof", title: "Maxed", updatedAt: "2026-01-01T00:00:00Z" });
      const needsUser = insertIssue(db, { attemptCount: 1, autoRetryNextAt: "2026-01-01T00:10:00Z", error: "approval denied; waiting for user input", title: "Needs user", updatedAt: "2026-01-01T00:00:00Z" });

      const byIssue = new Map(scanProjectFindings(db, "demo", { now: NOW }).map((finding) => [finding.issue_id, finding]));

      expect(byIssue.get(ready)).toMatchObject({ category: "transient", reason: "failed_retry_ready" });
      expect(byIssue.get(cooling)).toMatchObject({ category: "transient", reason: "failed_retry_cooling_down" });
      expect(byIssue.get(maxed)).toMatchObject({ category: "needs_user", reason: "failed_retry_exhausted" });
      expect(byIssue.get(needsUser)).toMatchObject({ category: "transient", reason: "failed_retry_ready" });
      expect([...byIssue.values()].every((finding) => !("action_candidate" in finding))).toBe(true);
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-project-findings-retry-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, issue: { attemptCount: number; autoRetryNextAt?: string; error: string; title: string; updatedAt: string }): number {
  db.sqlite.run(
    `insert into issues
      (project_id, title, status, error, attempt_count, auto_retry_next_at, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["demo", issue.title, "failed", issue.error, issue.attemptCount, issue.autoRetryNextAt ?? "", issue.updatedAt, issue.updatedAt]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing issue id");
  return row.id;
}

function insertProjectRetryPolicy(db: RunnerDatabase, retryPolicy: { backoff_minutes: number[]; enabled: boolean; max_attempts: number }): void {
  db.sqlite.run(
    `insert into project_pi_policies (project_id, retry_policy_json, created_at, updated_at)
     values (?, ?, ?, ?)`,
    ["demo", JSON.stringify(retryPolicy), "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}
