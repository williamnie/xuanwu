import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type RunnerDatabase } from "../../db/database.ts";
import { createDefaultRouter } from "../server.ts";
import { useTestDatabase } from "../../testing/harness.ts";



export function createTestFixture() {
  const BASE_URL = "http://127.0.0.1:3008";

  const openFixtureDatabase = useTestDatabase();

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
  return { BASE_URL, openFixtureDatabase, fullPatchPayload, expectedPatchedIssue, patchIssue, listEvents, insertProject, insertIssue, insertOpenRun, insertCommandEvidenceEvent, latestRun };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
