import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { getPiAction, listPiActionEvents, listPiHeartbeatEvents } from "../db/repositories/pi.ts";
import { runDelegationHeartbeatsOnce, runPiHeartbeatOnce } from "./heartbeatOrchestrator.ts";

const tempRoots: string[] = [];
const NOW = new Date("2026-06-02T10:00:00Z");

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI heartbeat action execution", () => {
  test("attended heartbeat creates pending approvals through authorization gate", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "project-a");
      const issueID = insertIssue(db, "project-a", "todo");

      const result = await runPiHeartbeatOnce({ database: db, now: NOW, projectID: "project-a" });

      expect(result).toMatchObject({ actions_proposed: 1, executed_actions: [], status: "completed" });
      const action = db.sqlite.query<{ id: string }, []>("select id from pi_actions order by created_at desc limit 1").get();
      expect(getPiAction(db, action?.id ?? "")).toMatchObject({
        action_type: "issue.enqueue",
        gate_decision: "ask",
        heartbeat_id: result.heartbeat_id,
        issue_id: issueID,
        status: "pending"
      });
      expect(listPiActionEvents(db, { actionId: action?.id }).map((event) => event.event_type)).toEqual([
        "candidate", "gate_decision", "pending_approval"
      ]);
      expect(statusOfIssue(db, issueID)).toBe("todo");
    } finally {
      db.close();
    }
  });

  test("delegated heartbeat executes authorized actions and records audit result", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "project-a");
      const issueID = insertIssue(db, "project-a", "todo");
      insertDelegation(db, "delegation-a", "project-a", {
        allowed_actions: ["issue.enqueue"],
        authorizedActions: [{ action_type: "issue.enqueue", issue_id: issueID, project_id: "project-a" }],
        mode: "delegated",
        scope: { project_id: "project-a" }
      });

      const result = await runDelegationHeartbeatsOnce({ database: db, now: NOW });
      const run = result.runs[0];
      const actionID = String(run?.executed_actions[0] ?? "");

      expect(run?.executed_actions).toHaveLength(1);
      expect(run).toMatchObject({ actions_proposed: 1, status: "completed" });
      expect(getPiAction(db, actionID)).toMatchObject({ gate_decision: "execute", status: "completed" });
      expect(listPiActionEvents(db, { actionId: actionID }).map((event) => event.event_type)).toEqual([
        "candidate", "gate_decision", "execution_started", "execution_result"
      ]);
      const audit = listPiHeartbeatEvents(db, { heartbeatId: run?.heartbeat_id }).find((event) => event.event_type === "audit");
      expect(JSON.parse(audit?.payload_json ?? "{}")).toMatchObject({ actions_executed: 1, actions_proposed: 1 });
      expect(listIssueEvents(db, issueID).map((event) => event.type)).toEqual(["issue.status_changed"]);
      expect(statusOfIssue(db, issueID)).toBe("todo");
    } finally {
      db.close();
    }
  });

  test("delegated execution errors keep heartbeat and action audit", async () => {
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
      const action = db.sqlite.query<{ id: string }, []>("select id from pi_actions limit 1").get();

      expect(run).toMatchObject({ status: "failed", error: expect.stringContaining("暂不支持") });
      expect(listPiActionEvents(db, { actionId: action?.id }).map((event) => event.event_type)).toEqual([
        "candidate", "gate_decision", "execution_started", "execution_error"
      ]);
      expect(listPiHeartbeatEvents(db, { heartbeatId: run?.heartbeat_id }).map((event) => event.event_type)).toEqual([
        "collect_signals", "evaluate_policies", "plan_actions", "authorization_gate", "action_proposed", "error", "audit"
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

function insertIssue(db: RunnerDatabase, projectID: string, status: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [projectID, `${status} issue`, status, "2026-06-02T09:00:00Z", "2026-06-02T09:00:00Z"]
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
