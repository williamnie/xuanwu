import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-issue-patch-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun issue patch API", () => {
  test("patches issue fields and records status change history", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueId = insertIssue(database, "demo");
      const response = await patchIssue(database, issueId, fullPatchPayload());
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toMatchObject(expectedPatchedIssue(issueId));
      expect(listEvents(database)).toEqual([
        { type: "issue.status_changed", payload: "{\"status\":\"todo\"}" }
      ]);
    } finally {
      database.close();
    }
  });

  test("defers a done claim until the active Provider Run reaches terminal state", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueId = insertIssue(database, "demo", "in_progress");
      insertOpenRun(database, issueId);

      const response = await patchIssue(database, issueId, { status: "done", error: "" });
      const run = latestRun(database, issueId);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: issueId,
        status: "in_progress",
        error: ""
      });
      expect(run).toMatchObject({
        status: "in_progress"
      });
      expect(run?.ended_at).toBe("");
      expect(listEvents(database).map((event) => event.type)).toEqual([
        "issue.pi_acceptance_deferred.v1"
      ]);
    } finally {
      database.close();
    }
  });

  test("routes an ended Run to PI acceptance without classifying command text", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueId = insertIssue(database, "demo", "in_progress");
      insertOpenRun(database, issueId);
      database.sqlite.run(
        "update issue_runs set status='failed', ended_at='2026-01-01T00:01:00Z' where issue_id=?",
        [issueId]
      );
      insertCommandEvidenceEvent(database, issueId, "/bin/zsh -lc 'custom-check --scope all; rc=$?; exit \"$rc\"'", 0);

      const response = await patchIssue(database, issueId, { status: "done", error: "" });
      const events = listEvents(database);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: issueId,
        status: "in_progress",
        error: ""
      });
      expect(events.map((event) => event.type)).toContain("issue.pi_acceptance_requested.v1");
      expect(events.some((event) => event.type.startsWith("issue.verification_gate_"))).toBe(false);
    } finally {
      database.close();
    }
  });

  test("rejects raw in progress to todo patches so callers cannot orphan a running session", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueId = insertIssue(database, "demo", "in_progress");
      insertOpenRun(database, issueId);

      const response = await patchIssue(database, issueId, { status: "todo" });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ message: "运行中的 Issue 请使用 retry 操作，避免重复创建 Session" });
      expect(latestRun(database, issueId)).toMatchObject({ status: "in_progress", ended_at: "" });
    } finally {
      database.close();
    }
  });

  test("rejects a generic failed status patch because only PI may decide failure", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueId = insertIssue(database, "demo", "in_progress");

      const response = await patchIssue(database, issueId, { status: "failed", error: "agent fallback" });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        message: "failed 只能由 PI 语义决策写入"
      });
      expect(database.sqlite.query<{ status: string }, [number]>("select status from issues where id=?").get(issueId))
        .toEqual({ status: "in_progress" });
    } finally {
      database.close();
    }
  });

  test("moves a triage issue to an existing project", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      insertProject(database, "target");
      const issueId = insertIssue(database, "demo");

      const response = await patchIssue(database, issueId, { project_id: "target" });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: issueId, project_id: "target" });
    } finally {
      database.close();
    }
  });

  test("rejects moving an issue after it leaves triage or to a missing project", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const triageIssueId = insertIssue(database, "demo");
      const queuedIssueId = insertIssue(database, "demo", "todo");

      const missingProject = await patchIssue(database, triageIssueId, { project_id: "missing" });
      const queuedIssue = await patchIssue(database, queuedIssueId, { project_id: "demo" });

      expect(missingProject.status).toBe(404);
      expect(await missingProject.json()).toEqual({ message: "资源不存在" });
      expect(queuedIssue.status).toBe(400);
      expect(await queuedIssue.json()).toEqual({ message: "只有 Triage 状态的 Issue 可以更换所属项目" });
    } finally {
      database.close();
    }
  });

  test("rejects moving an issue while a structural dependency relation exists", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      insertProject(database, "target");
      const upstream = createIssue(database, {
        project_id: "demo",
        status: "todo",
        title: "upstream"
      });
      const downstream = createIssue(database, {
        depends_on_issue_ids: [upstream.id],
        project_id: "demo",
        status: "triage",
        title: "downstream"
      });

      const response = await patchIssue(database, downstream.id, { project_id: "target" });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        message: "存在结构化依赖关系的 Issue 不能更换所属项目"
      });
    } finally {
      database.close();
    }
  });

  test("returns stable errors for invalid and missing issue patches", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueId = insertIssue(database, "demo");
      const invalidStatus = await patchIssue(database, issueId, { status: "bogus" });
      const missing = await patchIssue(database, 404, { title: "Missing" });

      expect(invalidStatus.status).toBe(400);
      expect(await invalidStatus.json()).toEqual({ message: "status 不合法" });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ message: "资源不存在" });
    } finally {
      database.close();
    }
  });
});

function fullPatchPayload(): Record<string, unknown> {
  return {
    title: "  Renamed patch  ",
    description: "  Updated body  ",
    status: "todo",
    priority: 2,
    required_mcp_capabilities: ["docs:resource:runbook"],
    recommended_mcp_capabilities: "docs:tool:search",
    error: "queued manually",
    source_session_id: "codex:thread-b",
    source_turn_id: "turn-b",
    source_excerpt: "来源摘录",
    agent_profile_id: "Codex Pro!",
    issue_log_mode: "debug",
    codex_thread_id: "thread-runtime",
    codex_turn_id: "turn-runtime"
  };
}

function expectedPatchedIssue(id: number): Record<string, unknown> {
  return {
    id,
    title: "Renamed patch",
    description: "Updated body",
    status: "todo",
    priority: 2,
    required_mcp_capabilities: "[\"docs:resource:runbook\"]",
    recommended_mcp_capabilities: "[\"docs:tool:search\"]",
    error: "queued manually",
    source_session_id: "thread-b",
    source_turn_id: "turn-b",
    source_excerpt: "来源摘录",
    agent_profile_id: "codex-pro",
    issue_log_mode: "debug",
    codex_thread_id: "thread-runtime",
    codex_turn_id: "turn-runtime"
  };
}

function patchIssue(db: RunnerDatabase, id: number, body: Record<string, unknown>): Promise<Response> {
  return createDefaultRouter({ database: db }).handle(new Request(`${BASE_URL}/api/issues/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" }
  }));
}

function listEvents(db: RunnerDatabase): Array<{ payload: string; type: string }> {
  return db.sqlite.query<{ payload: string; type: string }, []>(
    "select type, payload from issue_events order by id asc"
  ).all();
}

function insertProject(db: RunnerDatabase, id: string, cwd = join(dirname(db.path), `non-git-${id}`)): void {
  mkdirSync(cwd, { recursive: true });
  db.sqlite.run(
    `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [id, id, cwd, 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectId: string, status = "triage"): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, source_session_id, codex_thread_id, codex_turn_id, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [projectId, "Patch API", status, "thread-a", "thread-runtime", "turn-runtime", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}

function insertOpenRun(db: RunnerDatabase, issueId: number): void {
  db.sqlite.run(
    `insert into issue_runs (id, issue_id, attempt, status, started_at)
     values (?, ?, ?, ?, ?)`,
    [`issue-${issueId}-attempt-1`, issueId, 1, "in_progress", "2026-01-01T00:00:00Z"]
  );
}

function insertCommandEvidenceEvent(
  db: RunnerDatabase,
  issueId: number,
  command: string,
  exitCode: number
): void {
  const completedAtMs = Date.now();
  const rawPayload = JSON.stringify({
    item: {
      type: "commandExecution",
      id: `command-${issueId}`,
      command,
      cwd: "/tmp/demo",
      status: exitCode === 0 ? "completed" : "failed",
      commandActions: [{ type: "unknown", command }],
      aggregatedOutput: "focused verification",
      exitCode,
      durationMs: 20,
      completedAtMs
    }
  });
  db.sqlite.run(
    "insert into issue_events (issue_id, type, payload, created_at) values (?, 'issue.log', ?, ?)",
    [issueId, JSON.stringify({ type: "tool", raw_method: "item/completed", raw_payload: rawPayload }), new Date(completedAtMs).toISOString()]
  );
}

function latestRun(db: RunnerDatabase, issueId: number): Record<string, unknown> | null {
  return db.sqlite.query<Record<string, unknown>, [number]>(
    `select status, provider_session_id, provider_turn_id, ended_at, exit_reason, error
     from issue_runs where issue_id = ? order by attempt desc limit 1`
  ).get(issueId) ?? null;
}
