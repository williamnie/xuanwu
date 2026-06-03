import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { collectProjectHeartbeatSignals } from "./heartbeatSignals.ts";

const NOW = new Date("2026-06-04T10:00:00Z");
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI heartbeat signal collector", () => {
  test("builds a structured single-project snapshot from issues, runs, sessions, and settings", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      insertPiAgent(db, "pi-default");
      insertProjectPiSettings(db, "demo");
      const issueID = insertIssue(db, {
        error: "provider failed CODEX_API_KEY=fixture-secret",
        projectID: "demo",
        status: "failed"
      });
      insertRun(db, { issueID, runID: "run-a", status: "failed" });
      insertAgentSession(db, "demo", issueID);

      const snapshot = collectProjectHeartbeatSignals(db, "demo", NOW);

      expect(snapshot.issues).toEqual({ total: 1, status_counts: { failed: 1 } });
      expect(snapshot.issue_runs).toMatchObject({ total: 1, open: 0, status_counts: { failed: 1 } });
      expect(snapshot.issue_runs.recent[0]).toMatchObject({ issue_id: issueID, run_id: "run-a", status: "failed" });
      expect(snapshot.agent_sessions).toMatchObject({ total: 1, status_counts: { done: 1 } });
      expect(snapshot.agent_sessions.recent[0]).toMatchObject({ issue_id: issueID, session_key: "codex:thread-a" });
      expect(snapshot.project_settings.pi_policy?.verification_policy).toMatchObject({ pending_timeout_minutes: 1440 });
      expect(snapshot.project_settings.pi_settings).toMatchObject({ auto_manage: 1, max_actions_per_cycle: 3 });
      expect(snapshot.project_settings.project).toMatchObject({ id: "demo", provider: "codex" });
      expect(rowCount(db, "pi_actions")).toBe(0);
      expect(rowCount(db, "pi_heartbeat_runs")).toBe(0);
    } finally {
      db.close();
    }
  });

  test("returns safe empty data for a project with no issues, runs, sessions, or PI settings", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "empty");

      const snapshot = collectProjectHeartbeatSignals(db, "empty", NOW);

      expect(snapshot.issues).toEqual({ total: 0, status_counts: {} });
      expect(snapshot.issue_runs).toEqual({ total: 0, open: 0, status_counts: {}, recent: [] });
      expect(snapshot.agent_sessions).toEqual({ total: 0, status_counts: {}, recent: [] });
      expect(snapshot.project_settings.pi_settings).toBeNull();
      expect(snapshot.project?.latest_issues).toEqual([]);
      expect(snapshot.project?.recent_runs).toEqual([]);
      expect(snapshot.project?.recent_sessions).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("redacts sensitive fields from project config, runtime metadata, raw refs, and errors", async () => {
    const db = await openFixtureDatabase();
    try {
      insertSensitiveProject(db, "secret-demo");
      const issueID = insertIssue(db, {
        error: "error AUTH_TOKEN=issue-secret at /Users/xiaobei/issue.log",
        projectID: "secret-demo",
        status: "failed"
      });
      insertSensitiveRun(db, issueID);
      insertSensitiveAgentSession(db, "secret-demo", issueID);

      const snapshot = collectProjectHeartbeatSignals(db, "secret-demo", NOW);
      const json = JSON.stringify(snapshot);

      expect(json).toContain("[redacted]");
      expect(json).toContain("[redacted-path]");
      for (const forbidden of [
        "provider-secret", "run-secret", "raw-secret", "title-secret", "issue-secret",
        "runtime-secret", "Bearer abc.def", "/Users/xiaobei"
      ]) {
        expect(json).not.toContain(forbidden);
      }
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-heartbeat-signals-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects
      (id, name, cwd, provider, provider_config_json, auto_run, model, approval_policy,
       sandbox, default_skill_policy_json, default_mcp_policy_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "codex", "{}", 1, "gpt-5.4", "never", "workspace-write",
      "{}", "{}", 1, "2026-06-04T09:00:00Z", "2026-06-04T09:00:00Z"]
  );
}

function insertSensitiveProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects
      (id, name, cwd, provider, provider_config_json, default_skill_policy_json,
       default_mcp_policy_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, "Project CODEX_API_KEY=title-secret", "/Users/xiaobei/secret-demo", "codex",
      JSON.stringify({ api_key: "provider-secret", nested: { path: "/Users/xiaobei/provider.env" } }),
      JSON.stringify({ allowed: ["safe"], auth_token: "policy-secret" }),
      JSON.stringify({ resources: ["docs"], secret: "mcp-secret" }),
      1, "2026-06-04T09:00:00Z", "2026-06-04T09:00:00Z"]
  );
}

function insertPiAgent(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into pi_agents (id, name, enabled, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [id, id, 1, "2026-06-04T09:00:00Z", "2026-06-04T09:00:00Z"]
  );
}

function insertProjectPiSettings(db: RunnerDatabase, projectID: string): void {
  db.sqlite.run(
    `insert into project_pi_settings
      (project_id, pi_agent_id, auto_manage, auto_triage, auto_enqueue,
       notify_on_needs_user, max_actions_per_cycle, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [projectID, "pi-default", 1, 1, 0, 1, 3, "2026-06-04T09:00:00Z", "2026-06-04T09:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, issue: { error: string; projectID: string; status: string }): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, error, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [issue.projectID, `${issue.status} issue`, issue.status, issue.error,
      "2026-06-04T09:10:00Z", "2026-06-04T09:10:00Z"]
  );
  return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0;
}

function insertRun(db: RunnerDatabase, run: { issueID: number; runID: string; status: string }): void {
  db.sqlite.run(
    `insert into issue_runs
      (id, issue_id, attempt, status, provider, provider_session_id, started_at, ended_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [run.runID, run.issueID, 1, run.status, "codex", "thread-a",
      "2026-06-04T09:15:00Z", "2026-06-04T09:20:00Z"]
  );
}

function insertSensitiveRun(db: RunnerDatabase, issueID: number): void {
  db.sqlite.run(
    `insert into issue_runs
      (id, issue_id, attempt, status, provider, provider_session_id, started_at, ended_at,
       exit_reason, error, runtime_metadata_json)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["run-a", issueID, 1, "failed", "codex", "thread-secret", "2026-06-04T09:15:00Z",
      "2026-06-04T09:20:00Z", "Bearer abc.def", "TOKEN=run-secret at /Users/xiaobei/run.log",
      JSON.stringify({ auth_token: "runtime-secret", output_path: "/Users/xiaobei/runtime.log" })]
  );
}

function insertAgentSession(db: RunnerDatabase, projectID: string, issueID: number): void {
  db.sqlite.run(
    `insert into agent_sessions
      (session_key, provider, provider_session_id, project_id, issue_id, title, status,
       raw_ref, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["codex:thread-a", "codex", "thread-a", projectID, issueID, "Thread", "done", "{}",
      "2026-06-04T09:12:00Z", "2026-06-04T09:30:00Z"]
  );
}

function insertSensitiveAgentSession(db: RunnerDatabase, projectID: string, issueID: number): void {
  db.sqlite.run(
    `insert into agent_sessions
      (session_key, provider, provider_session_id, project_id, issue_id, title, status,
       raw_ref, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["codex:thread-secret", "codex", "thread-secret", projectID, issueID,
      "Session CODEX_API_KEY=title-secret", "failed",
      JSON.stringify({ secret: "raw-secret", file: "/Users/xiaobei/session.jsonl" }),
      "2026-06-04T09:12:00Z", "2026-06-04T09:30:00Z"]
  );
}

function rowCount(db: RunnerDatabase, table: string): number {
  return db.sqlite.query<{ count: number }, []>(`select count(*) as count from ${table}`).get()?.count ?? 0;
}
