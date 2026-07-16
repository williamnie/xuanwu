import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createPiDelegation, createPiHeartbeatRun } from "../db/repositories/pi.ts";
import { buildPiReport } from "./reports.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("PI report generator", () => {
  test("generates an empty report without publishing notifications", async () => {
    const db = await openFixtureDatabase();
    let published = 0;
    try {
      insertProject(db, "demo");

      const report = await buildPiReport({
        bus: { publish: () => { published += 1; } },
        database: db,
        now: new Date("2026-06-04T08:00:00Z"),
        projectID: "demo",
        since: "2026-06-03T20:00:00Z",
        type: "night_run_summary",
        until: "2026-06-04T08:00:00Z"
      });

      expect(report).toMatchObject({
        delegation_id: "",
        heartbeat_ids: [],
        issue_ids: [],
        project_id: "demo",
        source: "manual",
        status: "generated",
        summary: { total: 0 },
        summary_text_zh: expect.stringContaining("无活动"),
        type: "night_run_summary"
      });
      expect(published).toBe(0);
    } finally {
      db.close();
    }
  });

  test("generates a delegation-scoped report with related heartbeat and issues", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const included = insertIssue(db, "demo", "done", "Included", "bun test passed");
      insertStructuredVerifierReport(db, included, "pass");
      insertIssue(db, "demo", "failed", "Outside delegation");
      createPiDelegation(db, { id: "delegation-a", project_id: "demo", title: "Night window" });
      createPiHeartbeatRun(db, {
        delegation_id: "delegation-a",
        finished_at: "2026-06-03T21:10:00Z",
        id: "heartbeat-a",
        kind: "delegation",
        project_id: "demo",
        started_at: "2026-06-03T21:00:00Z",
        status: "completed"
      });
      insertActionEvent(db, "delegation-a", included);

      const report = await buildPiReport({
        database: db,
        delegationID: "delegation-a",
        now: new Date("2026-06-04T08:00:00Z"),
        since: "2026-06-03T20:00:00Z",
        source: "delegation",
        type: "night_run_summary",
        until: "2026-06-04T08:00:00Z"
      });

      expect(report).toMatchObject({
        delegation_id: "delegation-a",
        heartbeat_ids: ["heartbeat-a"],
        issue_ids: [included],
        project_id: "demo",
        source: "delegation",
        status: "generated",
        summary: { completed: 1, failed: 0, total: 1, verifier_pass: 1 }
      });
      expect(report.verifier_reviews).toEqual([
        expect.objectContaining({
          issue_id: included,
          verdict: "pass",
          recommended_next_action: expect.objectContaining({ action: "complete_via_gate" })
        })
      ]);
    } finally {
      db.close();
    }
  });

  test("builds a Chinese night summary with categories, evidence links, and redacted failures", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const done = insertIssue(db, "demo", "done", "Completed", "bun test passed");
      const needsUser = insertIssue(
        db,
        "demo",
        "failed",
        "Needs user",
        "approval denied; API_KEY=secret-value; /Users/xiaobei/private.txt"
      );
      const blocked = insertIssue(db, "demo", "failed", "Blocked", "unit tests failed");
      insertRun(db, done, "run-done", "done", "thread-done");
      insertSupervisorEvent(db, done, "action", {
        actionType: "session.resume_followup",
        decision: "resume_session"
      });
      insertSupervisorEvent(db, needsUser, "action", {
        actionType: "issue.retry_after",
        decision: "wait",
        retryAfterAt: "2026-06-03T22:00:00Z"
      });
      insertSupervisorEvent(db, needsUser, "decision", {
        diagnosisCode: "session_recovery_exhausted",
        decision: "needs_user"
      });
      createPiDelegation(db, { id: "delegation-a", project_id: "demo", title: "Night window" });
      createPiHeartbeatRun(db, {
        delegation_id: "delegation-a",
        finished_at: "2026-06-03T21:10:00Z",
        id: "heartbeat-a",
        kind: "delegation",
        project_id: "demo",
        started_at: "2026-06-03T21:00:00Z",
        status: "completed"
      });
      [done, needsUser, blocked].forEach((id) => insertActionEvent(db, "delegation-a", id));

      const report = await buildPiReport({
        database: db,
        delegationID: "delegation-a",
        now: new Date("2026-06-04T08:00:00Z"),
        since: "2026-06-03T20:00:00Z",
        source: "delegation",
        type: "night_run_summary",
        until: "2026-06-04T08:00:00Z"
      });
      const categories = report.issue_categories as Record<string, Array<Record<string, any>>>;
      const failedNeedsUser = categories.failed.find((issue) => issue.id === needsUser);

      expect(report.summary).toMatchObject({ blocked: 1, completed: 1, failed: 2, needs_user: 1, total: 3 });
      expect(report.supervisor_summary).toMatchObject({
        exhausted_recoveries: 1,
        needs_user_escalations: 1,
        rate_limit_waits: 1,
        recovered_issues: 1,
        recovery_actions: 1
      });
      expect(categories.completed).toEqual([expect.objectContaining({
        evidence_links: expect.objectContaining({
          audit: `/api/pi/audit-events?project_id=demo&issue_id=${done}`,
          issue: `/api/issues/${done}`,
          runs: `/api/issues/${done}/runs`,
          session: "/api/sessions/codex:thread-done"
        }),
        id: done
      })]);
      expect(categories.needs_user).toEqual([expect.objectContaining({ id: needsUser })]);
      expect(categories.blocked).toEqual([expect.objectContaining({ id: blocked })]);
      expect(failedNeedsUser?.error).toContain("[redacted]");
      expect(failedNeedsUser?.error).not.toContain("secret-value");
      expect(failedNeedsUser?.error).not.toContain("/Users/xiaobei");
      expect(String(report.summary_text_zh)).toContain("夜间执行总结");
      expect(String(report.summary_text_zh)).toContain("完成 1");
      expect(String(report.summary_text_zh)).toContain("失败 2");
      expect(String(report.summary_text_zh)).toContain("需用户 1");
      expect(String(report.summary_text_zh)).toContain("阻塞 1");
      expect(String(report.summary_text_zh)).toContain(`/api/issues/${done}`);
      expect(String(report.summary_text_zh)).toContain(`/api/pi/audit-events?project_id=demo&issue_id=${done}`);
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-report-generator-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "codex", 1, "2026-06-03T09:00:00Z", "2026-06-03T09:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectID: string, status: string, title: string, error = ""): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, error, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [projectID, title, status, error, "2026-06-03T21:05:00Z", "2026-06-03T21:05:00Z"]
  );
  return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0;
}

function insertActionEvent(db: RunnerDatabase, delegationID: string, issueID: number): void {
  db.sqlite.run(
    `insert into pi_action_events
      (action_id, project_id, issue_id, event_type, actor, delegation_id, created_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    ["action-a", "demo", issueID, "execution_result", "executor", delegationID, "2026-06-03T21:08:00Z"]
  );
}

function insertRun(db: RunnerDatabase, issueID: number, id: string, status: string, sessionID: string): void {
  db.sqlite.run(
    `insert into issue_runs
      (id, issue_id, attempt, status, provider, provider_session_id, codex_thread_id, started_at, ended_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, issueID, 1, status, "codex", sessionID, sessionID, "2026-06-03T21:05:00Z", "2026-06-03T21:08:00Z"]
  );
}

function insertSupervisorEvent(db: RunnerDatabase, issueID: number, eventType: string, input: {
  actionType?: string; decision?: string; diagnosisCode?: string; retryAfterAt?: string;
}): void {
  db.sqlite.run(
    `insert into issue_supervisor_events
      (issue_id, project_id, event_type, diagnosis_code, decision, action_type, retry_after_at, payload_json, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [issueID, "demo", eventType, input.diagnosisCode ?? "", input.decision ?? "",
      input.actionType ?? "", input.retryAfterAt ?? "", "{}", "2026-06-03T21:09:00Z"]
  );
}

function insertStructuredVerifierReport(db: RunnerDatabase, issueID: number, verdict: "pass"): void {
  const review = {
    schema_version: 1,
    schema_id: "xw.verifier-review.v1",
    input_context: {
      acceptance_contract_version: 1,
      acceptance_criteria: [{
        description: "Deliver the Issue",
        id: "issue-delivery",
        required: true,
        verification_policy_ref: "agent-execution-contract"
      }],
      evaluated_at: "2026-06-03T21:07:00.000Z",
      evidence: [],
      policy_ref: "verification-policy:agent-execution-contract@1",
      projection_errors: [],
      work_id: `xw:work:issues:${issueID}`,
      work_revision: 1,
      work_status: "pending_verification"
    },
    findings: [{
      acceptance_criterion_ids: ["issue-delivery"],
      evidence_ids: [],
      finding_id: "acceptance:issue-delivery",
      kind: "acceptance_criterion",
      result: verdict,
      summary: "Acceptance criterion is supported by the policy decision."
    }],
    verdict,
    missing_evidence: [],
    recommended_next_action: {
      action: "complete_via_gate",
      reason: "Request the audited deterministic completion gate."
    },
    gate_consistency: { expected_status: "done", policy_decision: "passed", satisfied: true }
  };
  db.sqlite.run(
    "insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)",
    [issueID, "issue.verification_report", JSON.stringify({ structured_review: review }), "2026-06-03T21:07:00Z"]
  );
}
