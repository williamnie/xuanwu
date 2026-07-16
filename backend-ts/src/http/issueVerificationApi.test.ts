import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-issue-verification-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun issue verification API", () => {
  test("accept finalizes pending verification to done and records review events", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueId = insertIssue(database, { error: "bun test passed", status: "pending_verification" });
      const response = await reviewIssue(database, issueId, { action: "accept", comment: "人工验收通过" });
      const body = await response.json() as Record<string, unknown>;
      const events = listEvents(database);

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ id: issueId, status: "done", error: "" });
      expect(events.map((event) => event.type)).toEqual([
        "issue.comment",
        "issue.verification_human_evidence.v1",
        "issue.verification_reviewed",
        "issue.verification_gate_intent.v1",
        "issue.status_changed",
        "issue.verification_gate_outcome.v1"
      ]);
      expect(JSON.parse(events[2].payload)).toEqual({
        action: "accept",
        comment: "人工验收通过",
        status: "done"
      });
      expect(JSON.parse(events.at(-1)?.payload ?? "{}")).toMatchObject({
        evaluation: {
          decision: "overridden",
          override: { applied: true },
          satisfied: true
        },
        target_status: "done"
      });
    } finally {
      database.close();
    }
  });

  test("reject and request_changes keep comments as issue error", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const rejectedId = insertIssue(database, { error: "evidence", status: "pending_verification" });
      const changesId = insertIssue(database, { error: "evidence", status: "pending_verification" });

      const rejected = await reviewIssue(database, rejectedId, { action: "reject", comment: "缺少测试" });
      const changes = await reviewIssue(database, changesId, { action: "request_changes", comment: "补 smoke" });

      expect(rejected.status).toBe(200);
      expect(await rejected.json()).toMatchObject({ id: rejectedId, status: "failed", error: "缺少测试" });
      expect(changes.status).toBe(200);
      expect(await changes.json()).toMatchObject({ id: changesId, status: "triage", error: "补 smoke" });
    } finally {
      database.close();
    }
  });

  test("returns stable errors for invalid verification payloads", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const pendingId = insertIssue(database, { error: "evidence", status: "pending_verification" });
      const todoId = insertIssue(database, { error: "", status: "todo" });

      const invalidAction = await reviewIssue(database, pendingId, { action: "bogus" });
      const wrongStatus = await reviewIssue(database, todoId, { action: "accept" });
      const missing = await reviewIssue(database, 404, { action: "accept" });
      const invalidJson = await createDefaultRouter({ database }).handle(new Request(`${BASE_URL}/api/issues/${pendingId}/verification`, {
        method: "POST",
        body: "{bad-json",
        headers: { "content-type": "application/json" }
      }));

      expect(invalidAction.status).toBe(400);
      expect(await invalidAction.json()).toEqual({ message: "verification action 必须是 accept、reject 或 request_changes" });
      expect(wrongStatus.status).toBe(400);
      expect(await wrongStatus.json()).toEqual({ message: "issue 当前不在 pending_verification 状态" });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ message: "资源不存在" });
      expect(invalidJson.status).toBe(400);
      expect(await invalidJson.json()).toEqual({ message: "请求体不是合法 JSON" });
    } finally {
      database.close();
    }
  });
});

function reviewIssue(db: RunnerDatabase, id: number, body: Record<string, unknown>): Promise<Response> {
  return createDefaultRouter({ database: db }).handle(new Request(`${BASE_URL}/api/issues/${id}/verification`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" }
  }));
}

type IssueFixture = {
  error: string;
  status: string;
};

function insertIssue(db: RunnerDatabase, issue: IssueFixture): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, error, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    ["demo", "Verification API", issue.status, issue.error, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function listEvents(db: RunnerDatabase): Array<{ payload: string; type: string }> {
  return db.sqlite.query<{ payload: string; type: string }, []>(
    "select type, payload from issue_events order by id asc"
  ).all();
}
