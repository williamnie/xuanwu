import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { listPiGuardianEvents, listPiHeartbeatEvents } from "../db/repositories/pi.ts";
import { runDelegationHeartbeatsOnce, runPiHeartbeatOnce } from "./heartbeatOrchestrator.ts";

const tempRoots: string[] = [];
const NOW = new Date("2026-06-02T10:00:00Z");

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI heartbeat decision boundary", () => {
  test("attended heartbeat collects state without manufacturing an action", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "project-a");
      const issueID = insertIssue(db, "project-a", "todo");

      const result = await runPiHeartbeatOnce({ database: db, now: NOW, projectID: "project-a" });

      expect(result).toMatchObject({ actions_proposed: 0, executed_actions: [], status: "completed" });
      expect(listPiGuardianEvents(db, { projectId: "project-a" })).toEqual([]);
      expect(rowCount(db, "pi_actions")).toBe(0);
      expect(statusOfIssue(db, issueID)).toBe("todo");
    } finally {
      db.close();
    }
  });

  test("delegation authorization does not make heartbeat choose an action", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "project-a");
      const issueID = insertIssue(db, "project-a", "todo");
      insertDelegation(db, "delegation-a", "project-a", {
        allowed_actions: ["issue.enqueue"],
        allowed_mcp_capabilities: ["docs:resource:runbook"],
        allowed_skill_intents: ["codex-issue-runner"],
        authorizedActions: [{ action_type: "issue.enqueue", issue_id: issueID, project_id: "project-a" }],
        mode: "delegated",
        scope: { project_id: "project-a" }
      });

      const result = await runDelegationHeartbeatsOnce({ database: db, now: NOW });
      const run = result.runs[0];

      expect(run?.executed_actions).toEqual([]);
      expect(run).toMatchObject({ actions_proposed: 0, status: "completed" });
      expect(run?.policy.authorization_summary).toMatchObject({
        allowed_mcp_capabilities: ["docs:resource:runbook"],
        allowed_skill_intents: ["codex-issue-runner"]
      });
      expect(rowCount(db, "pi_actions")).toBe(0);
      const audit = listPiHeartbeatEvents(db, { heartbeatId: run?.heartbeat_id }).find((event) => event.event_type === "audit");
      expect(JSON.parse(audit?.payload_json ?? "{}")).toMatchObject({ actions_executed: 0, actions_proposed: 0 });
      expect(listIssueEvents(db, issueID).map((event) => event.type)).toEqual([]);
      expect(statusOfIssue(db, issueID)).toBe("todo");
    } finally {
      db.close();
    }
  });

  test("delegated heartbeat does not execute provider-specific enqueue side effects", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "project-a", "noop");
      const issueID = insertIssue(db, "project-a", "todo");
      insertDelegation(db, "delegation-a", "project-a", {
        allowed_actions: ["issue.enqueue"],
        authorizedActions: [{ action_type: "issue.enqueue", issue_id: issueID, project_id: "project-a" }],
        mode: "delegated",
        scope: { project_id: "project-a" }
      });

      const result = await runDelegationHeartbeatsOnce({ database: db, now: NOW });
      const run = result.runs[0];

      expect(run).toMatchObject({ status: "completed", error: "" });
      expect(rowCount(db, "pi_actions")).toBe(0);
      expect(listPiHeartbeatEvents(db, { heartbeatId: run?.heartbeat_id }).map((event) => event.event_type)).toEqual([
        "collect_signals", "evaluate_policies", "delegate_decision", "authorization_gate", "audit", "schedule_next_tick"
      ]);
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-heartbeat-action-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string, provider = "codex"): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, auto_run, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, provider, 1, 1, "2026-06-02T09:00:00Z", "2026-06-02T09:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectID: string, status: string, skills: string[] = []): number {
  db.sqlite.run(
    `insert into issues
       (project_id, title, status, recommended_skill_intents_json, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [projectID, `${status} issue`, status, JSON.stringify(skills), "2026-06-02T09:00:00Z", "2026-06-02T09:00:00Z"]
  );
  return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0;
}

function insertDelegation(db: RunnerDatabase, id: string, projectID: string, authorization: unknown): void {
  db.sqlite.run(
    `insert into pi_delegations
     (id, project_id, title, status, intent_json, authorization_json, next_heartbeat_at, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, projectID, "Watch blockers", "active", "{}", JSON.stringify(authorization), "2026-06-02T09:59:00Z", "2026-06-02T09:00:00Z", "2026-06-02T09:00:00Z"]
  );
}

function statusOfIssue(db: RunnerDatabase, issueID: number): string {
  return db.sqlite.query<{ status: string }, [number]>("select status from issues where id=?").get(issueID)?.status ?? "";
}

function rowCount(db: RunnerDatabase, table: string): number {
  return db.sqlite.query<{ count: number }, []>(`select count(*) as count from ${table}`).get()?.count ?? 0;
}
