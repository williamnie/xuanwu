import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { createIssueRun } from "../db/repositories/issueRuns.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { createPiAction, pausePiHeartbeat } from "../db/repositories/pi.ts";
import { readProjectIssueDependencies } from "../domain/work/issueDependency.ts";
import { createHumanReviewRequest, readIssueVerificationProjection } from "../domain/review/humanReview.ts";
import { runPiVerificationCoordinatorOnce } from "./piVerificationCoordinator.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("PI verification coordinator", () => {
  test("runs a real PI cycle for PI-owned verification and releases the downstream dependency", async () => {
    const db = await fixture();
    try {
      const parent = createIssue(db, {
        project_id: "demo",
        status: "pending_verification",
        title: "Parent delivery"
      });
      const child = createIssue(db, {
        depends_on_issue_ids: [parent.id],
        project_id: "demo",
        status: "todo",
        title: "Downstream work"
      });
      const observedPhases: string[] = [];
      const result = await runPiVerificationCoordinatorOnce({
        database: db,
        runProjectCycle: async ({ projectId }) => {
          expect(projectId).toBe("demo");
          observedPhases.push(readIssueVerificationProjection(db, parent.id).phase);
          updateIssue(db, parent.id, { error: "", status: "done" });
        }
      });

      expect(result).toEqual({
        failed: 0,
        issues: 1,
        projects: 1,
        skipped: 0,
        started: 1
      });
      expect(observedPhases).toEqual(["pi_verifying"]);
      expect(readIssueVerificationProjection(db, parent.id)).toMatchObject({
        activity: { attempt: 1, status: "completed" },
        owner: "pi",
        phase: "complete"
      });
      expect(readProjectIssueDependencies(db, "demo").get(child.id)).toMatchObject({
        ready: true,
        reason: "ready"
      });
      expect(activityTypes(db, parent.id)).toEqual([
        "issue.pi_verification_started.v1",
        "issue.pi_verification_completed.v1"
      ]);
    } finally {
      db.close();
    }
  });

  test("does not launch PI verification while an explicit human decision request is open", async () => {
    const db = await fixture();
    let calls = 0;
    try {
      const issue = createIssue(db, {
        project_id: "demo",
        status: "pending_verification",
        title: "Needs a product decision"
      });
      createHumanReviewRequest(db, issue.id, {
        question: "是否接受当前产品范围？"
      });
      const result = await runPiVerificationCoordinatorOnce({
        database: db,
        runProjectCycle: async () => { calls += 1; }
      });

      expect(result).toMatchObject({ issues: 0, projects: 0, started: 0 });
      expect(calls).toBe(0);
      expect(readIssueVerificationProjection(db, issue.id)).toMatchObject({
        owner: "human",
        phase: "human_review"
      });
    } finally {
      db.close();
    }
  });

  test("settles an incomplete verifier carrier as an internal failure without recursively verifying it", async () => {
    const db = await fixture();
    let calls = 0;
    try {
      const parent = createIssue(db, {
        project_id: "demo",
        status: "pending_verification",
        title: "Parent delivery"
      });
      const child = createIssue(db, {
        project_id: "demo",
        status: "in_progress",
        title: `Verifier: #${parent.id}`,
        workflow_snapshot_json: JSON.stringify({
          agent_role: "verifier",
          parent_issue_id: parent.id
        })
      });
      const run = createIssueRun(db, child.id);
      db.sqlite.run("update issue_runs set status='done', ended_at=? where id=?", [
        "2026-07-31T06:00:00Z",
        run.id
      ]);
      updateIssue(db, child.id, { status: "pending_verification" });
      createPiAction(db, {
        id: `verifier-action-${child.id}`,
        action_type: "agent.workflow_request",
        gate_decision: "execute",
        issue_id: parent.id,
        payload_json: JSON.stringify({ workflow_snapshot_json: child.workflow_snapshot_json }),
        project_id: child.project_id,
        result_json: JSON.stringify(child),
        status: "completed"
      });

      const result = await runPiVerificationCoordinatorOnce({
        database: db,
        runProjectCycle: async () => {
          calls += 1;
          updateIssue(db, parent.id, { status: "done" });
        }
      });

      expect(result).toMatchObject({ issues: 1, projects: 1, started: 1 });
      expect(calls).toBe(1);
      expect(getIssueStatus(db, child.id)).toBe("cancelled");
      expect(activityTypes(db, child.id)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("does not bypass an explicit project heartbeat pause", async () => {
    const db = await fixture();
    let calls = 0;
    try {
      const issue = createIssue(db, {
        project_id: "demo",
        status: "pending_verification",
        title: "Paused verification"
      });
      pausePiHeartbeat(db, {
        reason: "operator maintenance",
        scopeId: "demo",
        scopeType: "project"
      });

      const result = await runPiVerificationCoordinatorOnce({
        database: db,
        runProjectCycle: async () => { calls += 1; }
      });

      expect(result).toMatchObject({ issues: 0, projects: 0, started: 0 });
      expect(calls).toBe(0);
      expect(activityTypes(db, issue.id)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("shows waiting and applies a cooldown instead of claiming that a completed cycle is still running", async () => {
    const db = await fixture();
    let calls = 0;
    try {
      const issue = createIssue(db, {
        project_id: "demo",
        status: "pending_verification",
        title: "Missing Evidence"
      });
      const first = await runPiVerificationCoordinatorOnce({
        cooldownMs: 60_000,
        database: db,
        runProjectCycle: async () => { calls += 1; }
      });
      const activityAt = readIssueVerificationProjection(db, issue.id).activity!.updated_at;
      const second = await runPiVerificationCoordinatorOnce({
        cooldownMs: 60_000,
        database: db,
        now: new Date(Date.parse(activityAt) + 30_000),
        runProjectCycle: async () => { calls += 1; }
      });

      expect(first.started).toBe(1);
      expect(second.started).toBe(0);
      expect(calls).toBe(1);
      expect(readIssueVerificationProjection(db, issue.id)).toMatchObject({
        activity: { status: "waiting" },
        phase: "pi_waiting"
      });
    } finally {
      db.close();
    }
  });

  test("surfaces a failed PI cycle instead of displaying a false running state", async () => {
    const db = await fixture();
    try {
      const issue = createIssue(db, {
        project_id: "demo",
        status: "pending_verification",
        title: "Verifier unavailable"
      });
      const result = await runPiVerificationCoordinatorOnce({
        database: db,
        runProjectCycle: async () => { throw new Error("agentic RPC unavailable"); }
      });

      expect(result.failed).toBe(1);
      expect(readIssueVerificationProjection(db, issue.id)).toMatchObject({
        activity: { error: "agentic RPC unavailable", status: "failed" },
        phase: "pi_blocked"
      });
    } finally {
      db.close();
    }
  });
});

async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-verification-coordinator-"));
  roots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
     values ('demo', 'Demo', ?, 'codex', 1, ?, ?)`,
    [root, "2026-07-31T05:00:00Z", "2026-07-31T05:00:00Z"]
  );
  db.sqlite.run(
    `insert into project_pi_settings (project_id, created_at, updated_at)
     values ('demo', ?, ?)`,
    ["2026-07-31T05:00:00Z", "2026-07-31T05:00:00Z"]
  );
  return db;
}

function activityTypes(db: RunnerDatabase, issueID: number): string[] {
  return listIssueEvents(db, issueID, {
    types: [
      "issue.pi_verification_queued.v1",
      "issue.pi_verification_started.v1",
      "issue.pi_verification_waiting.v1",
      "issue.pi_verification_completed.v1",
      "issue.pi_verification_failed.v1"
    ]
  }).map((event) => event.type);
}

function getIssueStatus(db: RunnerDatabase, issueID: number): string {
  const row = db.sqlite.query<{ status: string }, [number]>(
    "select status from issues where id=?"
  ).get(issueID);
  return row?.status ?? "";
}
