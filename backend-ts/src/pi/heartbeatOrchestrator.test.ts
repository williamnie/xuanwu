import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import {
  diagnosePiHeartbeat,
  listPiHeartbeatEvents,
  pausePiHeartbeat,
  resumePiHeartbeat
} from "../db/repositories/pi.ts";
import { runDelegationHeartbeatsOnce, runPiHeartbeatOnce } from "./heartbeatOrchestrator.ts";

const tempRoots: string[] = [];
const NOW = new Date("2026-06-02T10:00:00Z");

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI heartbeat orchestrator", () => {
  test("runs one project heartbeat and persists audit timeline", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "project-a");
      const issueID = insertIssue(db, "project-a", "failed", "network error: unexpected eof");

      const result = await runPiHeartbeatOnce({ database: db, now: NOW, projectID: "project-a" });

      expect(result).toMatchObject({ project_id: "project-a", status: "completed" });
      expect(result.signals.issues.status_counts.failed).toBe(1);
      expect(result.action_candidates).toContainEqual(expect.objectContaining({
        action_type: "issue.retry_proposal",
        issue_id: issueID
      }));
      expect(result.actions_proposed).toBe(1);
      expect(result.next_tick_at).toBe("2026-06-02T10:01:00Z");

      const stored = db.sqlite.query<{ status: string; result_json: string }, []>(
        "select status, result_json from pi_heartbeat_runs"
      ).get();
      expect(stored?.status).toBe("completed");
      expect(JSON.parse(stored?.result_json ?? "{}").heartbeat_id).toBe(result.heartbeat_id);

      expect(listPiHeartbeatEvents(db, { heartbeatId: result.heartbeat_id }).map((event) => event.event_type)).toEqual([
        "collect_signals",
        "evaluate_policies",
        "plan_actions",
        "authorization_gate",
        "action_proposed",
        "audit",
        "schedule_next_tick"
      ]);
    } finally {
      db.close();
    }
  });

  test("collects heartbeat signal families from runner state", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "project-a");
      const issueID = insertIssue(db, "project-a", "failed", "unexpected eof");
      insertClosedRun(db, issueID);
      insertIssueEvent(db, issueID);
      insertAgentSession(db, "project-a", issueID);
      insertProjectHold(db, "project-a");
      insertCronTask(db, "project-a");
      insertDelegation(db, "delegation-a", "project-a");
      insertPiConversation(db, "project-a");
      insertMemoryItem(db, "project-a");

      const result = await runPiHeartbeatOnce({ database: db, now: NOW, projectID: "project-a" });

      expect(result.signals.project?.recent_runs).toHaveLength(1);
      expect(result.signals.project?.recent_sessions).toHaveLength(1);
      expect(result.signals.project?.active_holds).toHaveLength(1);
      expect(result.signals.cron).toEqual({ active: 1, due: 1, total: 1 });
      expect(result.signals.delegations).toEqual({ active: 1, due: 1 });
      expect(result.signals.memory).toEqual({ active: 1, pinned: 1 });
      expect(result.signals.pi_conversations).toEqual({ active: 1, total: 1 });
      expect(result.signals.provider_health).toEqual({ provider: "codex", status: "configured" });
      expect(result.signals.usage_cost).toEqual({ status: "not_configured", total_tokens: 0 });
    } finally {
      db.close();
    }
  });

  test("scans active delegations and generates delegated candidates", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "project-a");
      const issueID = insertIssue(db, "project-a", "failed", "connection reset by peer");
      insertDelegation(db, "delegation-a", "project-a");

      const result = await runDelegationHeartbeatsOnce({ database: db, now: NOW });

      expect(result).toMatchObject({ scanned: 1, started: 1, skipped: 0 });
      expect(result.runs[0]).toMatchObject({ delegation_id: "delegation-a", project_id: "project-a", status: "completed" });
      expect(result.runs[0]?.action_candidates).toContainEqual(expect.objectContaining({
        action_type: "issue.retry_proposal",
        issue_id: issueID
      }));

      const action = db.sqlite.query<{ gate_decision: string; heartbeat_id: string; project_id: string; status: string }, []>(
        "select gate_decision, heartbeat_id, project_id, status from pi_actions order by created_at desc limit 1"
      ).get();
      expect(action?.project_id).toBe("project-a");
      expect(action).toMatchObject({
        gate_decision: "deny",
        heartbeat_id: result.runs[0]?.heartbeat_id,
        status: "denied"
      });
    } finally {
      db.close();
    }
  });


  test("continues delegation batch when one delegation references a missing project", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "project-a");
      insertDelegation(db, "delegation-bad", "missing-project");
      insertDelegation(db, "delegation-good", "project-a");

      const result = await runDelegationHeartbeatsOnce({ database: db, now: NOW });

      expect(result).toMatchObject({ scanned: 2, skipped: 0, started: 2 });
      expect(result.runs.map((run) => run.status)).toEqual(["failed", "completed"]);
      expect(result.runs[0]).toMatchObject({ error: "project not found", project_id: "missing-project" });
      expect(result.runs[1]).toMatchObject({ project_id: "project-a", status: "completed" });
    } finally {
      db.close();
    }
  });

  test("respects global executor serialization by only proposing while executor work is active", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "project-a");
      const runningIssue = insertIssue(db, "project-a", "in_progress", "");
      insertOpenRun(db, runningIssue);
      const failedIssue = insertIssue(db, "project-a", "failed", "timeout while reading stream");

      const result = await runPiHeartbeatOnce({ database: db, now: NOW, projectID: "project-a" });

      expect(result.policy.executor_busy).toBe(true);
      expect(result.executed_actions).toEqual([]);
      expect(statusOfIssue(db, failedIssue)).toBe("failed");
      expect(openRunCount(db)).toBe(1);
    } finally {
      db.close();
    }
  });

  test("supports pause resume diagnostics and releases reentry lock after failure", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "project-a");
      pausePiHeartbeat(db, { reason: "maintenance", scopeId: "project-a", scopeType: "project" });

      const skipped = await runPiHeartbeatOnce({ database: db, now: NOW, projectID: "project-a" });
      expect(skipped).toMatchObject({ skip_reason: "heartbeat is paused", status: "skipped" });
      expect(diagnosePiHeartbeat(db, { scopeId: "project-a", scopeType: "project" }).control?.paused).toBe(true);

      resumePiHeartbeat(db, { scopeId: "project-a", scopeType: "project" });
      const failed = await runPiHeartbeatOnce({
        collectSignals: () => { throw new Error("collector boom"); },
        database: db,
        now: NOW,
        projectID: "project-a"
      });
      expect(failed.status).toBe("failed");
      expect(failed.error).toBe("collector boom");
      expect(failed.next_tick_at).toBe("2026-06-02T10:05:00Z");

      const recovered = await runPiHeartbeatOnce({ database: db, now: NOW, projectID: "project-a" });
      expect(recovered.status).toBe("completed");
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-heartbeat-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, auto_run, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, 1, 1, "2026-06-02T09:00:00Z", "2026-06-02T09:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectID: string, status: string, error: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, error, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [projectID, `${status} issue`, status, error, "2026-06-02T09:00:00Z", "2026-06-02T09:00:00Z"]
  );
  return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0;
}

function insertOpenRun(db: RunnerDatabase, issueID: number): void {
  db.sqlite.run(
    `insert into issue_runs (id, issue_id, attempt, status, started_at, ended_at)
     values (?, ?, ?, ?, ?, ?)`,
    [`issue-${issueID}-attempt-1`, issueID, 1, "in_progress", "2026-06-02T09:10:00Z", ""]
  );
}

function insertDelegation(db: RunnerDatabase, id: string, projectID: string): void {
  db.sqlite.run(
    `insert into pi_delegations
     (id, project_id, title, status, intent_json, authorization_json, next_heartbeat_at, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, projectID, "Watch blockers", "active", "{}", "{}", "2026-06-02T09:59:00Z", "2026-06-02T09:00:00Z", "2026-06-02T09:00:00Z"]
  );
}

function insertClosedRun(db: RunnerDatabase, issueID: number): void {
  db.sqlite.run(
    `insert into issue_runs (id, issue_id, attempt, status, started_at, ended_at)
     values (?, ?, ?, ?, ?, ?)`,
    [`issue-${issueID}-attempt-1`, issueID, 1, "failed", "2026-06-02T09:10:00Z", "2026-06-02T09:20:00Z"]
  );
}

function insertIssueEvent(db: RunnerDatabase, issueID: number): void {
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, "issue.error", JSON.stringify({ error: "unexpected eof" }), "2026-06-02T09:21:00Z"]
  );
}

function insertAgentSession(db: RunnerDatabase, projectID: string, issueID: number): void {
  db.sqlite.run(
    `insert into agent_sessions
      (session_key, provider, provider_session_id, project_id, issue_id, title, status, raw_ref, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["codex:thread-a", "codex", "thread-a", projectID, issueID, "Session", "done", "{}", "2026-06-02T09:00:00Z", "2026-06-02T09:30:00Z"]
  );
}

function insertProjectHold(db: RunnerDatabase, projectID: string): void {
  db.sqlite.run(
    `insert into project_holds (project_id, reason, message, hold_since, updated_at) values (?, ?, ?, ?, ?)`,
    [projectID, "usage_limit", "wait", "2026-06-02T09:00:00Z", "2026-06-02T09:00:00Z"]
  );
}

function insertCronTask(db: RunnerDatabase, projectID: string): void {
  db.sqlite.run(
    `insert into cron_tasks
      (name, project_id, action, mode, next_run_at, status, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["Heartbeat cron", projectID, "triage_to_todo", "once", "2026-06-02T09:59:00Z", "active", "2026-06-02T09:00:00Z", "2026-06-02T09:00:00Z"]
  );
}

function insertPiConversation(db: RunnerDatabase, projectID: string): void {
  db.sqlite.run(
    `insert into pi_conversations (id, project_id, pi_agent_id, status, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    ["conv-a", projectID, "pi-default", "active", "2026-06-02T09:00:00Z", "2026-06-02T09:00:00Z"]
  );
}

function insertMemoryItem(db: RunnerDatabase, projectID: string): void {
  db.sqlite.run(
    `insert into pi_memory_items (id, scope, scope_id, kind, content, pinned, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["mem-a", "project", projectID, "note", "remember", 1, "2026-06-02T09:00:00Z", "2026-06-02T09:00:00Z"]
  );
}

function statusOfIssue(db: RunnerDatabase, issueID: number): string {
  return db.sqlite.query<{ status: string }, [number]>("select status from issues where id=?").get(issueID)?.status ?? "";
}

function openRunCount(db: RunnerDatabase): number {
  return db.sqlite.query<{ count: number }, []>("select count(*) as count from issue_runs where ended_at=''").get()?.count ?? 0;
}
