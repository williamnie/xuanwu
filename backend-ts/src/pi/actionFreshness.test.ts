import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { upsertAgentSession } from "../db/repositories/agentSessions.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { createPiAction, getPiAction } from "../db/repositories/pi.ts";
import { getIssueAsWork } from "../domain/work/issueAdapter.ts";
import { createHumanReviewRequest } from "../domain/review/humanReview.ts";
import { createPendingPiAction } from "./actionEngine.ts";
import {
  evaluatePiActionFreshness,
  humanReviewExpectedState,
  issueBatchExpectedState,
  issueEnqueueExpectedState,
  sessionExpectedState
} from "./actionFreshness.ts";
import { expirePendingPiActionApprovals } from "./mcpApprovalExpiry.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop() ?? "", { recursive: true, force: true });
});

describe("PI action freshness", () => {
  test("revalidates Run interrupt revisions and terminal state", async () => {
    const db = await fixture();
    try {
      insertIssue(db, 701, "in_progress");
      insertRun(db, 701, "run-701", "in_progress", "", 5);
      const action = createPiAction(db, {
        action_type: "run.interrupt",
        expected_state_json: JSON.stringify({ attempt_revision: 5, revision: 0 }),
        id: "interrupt-701",
        issue_id: 701,
        payload_json: JSON.stringify({
          action: "interrupt",
          expected_attempt_revision: 5,
          expected_revision: 0,
          run_id: "xw:run:issue_runs:run-701"
        }),
        project_id: "demo",
        status: "pending"
      });

      expect(evaluatePiActionFreshness(db, action)).toEqual({ fresh: true });
      db.sqlite.run("update issue_runs set status='succeeded', ended_at=? where id='run-701'", [
        "2026-01-01T01:00:00Z"
      ]);
      expect(evaluatePiActionFreshness(db, action)).toEqual({
        fresh: false,
        reason: "target_run_already_terminal:succeeded"
      });
    } finally {
      db.close();
    }
  });

  test("revalidates the exact open Human Review request and revision", async () => {
    const db = await fixture();
    try {
      insertIssue(db, 702, "needs_user");
      const first = createHumanReviewRequest(db, 702, { question: "接受当前范围吗？" });
      const issue = requireIssue(db, 702);
      const action = createPiAction(db, {
        action_type: "human_review.respond",
        expected_state_json: JSON.stringify(humanReviewExpectedState(issue, first)),
        id: "review-702",
        issue_id: 702,
        payload_json: JSON.stringify({
          action: "accept",
          issue_id: 702,
          review_request_id: first.id,
          review_revision: first.revision
        }),
        project_id: "demo",
        status: "pending"
      });

      expect(evaluatePiActionFreshness(db, action)).toEqual({ fresh: true });
      const second = createHumanReviewRequest(db, 702, { question: "接受新的范围吗？" });
      expect(evaluatePiActionFreshness(db, action)).toEqual({
        fresh: false,
        reason: `human_review_changed:${second.id}:${second.revision}`
      });
    } finally {
      db.close();
    }
  });

  test("revalidates every Issue in a batch mutation", async () => {
    const db = await fixture();
    try {
      insertIssue(db, 703, "triage");
      insertIssue(db, 704, "triage");
      const issues = [requireIssue(db, 703), requireIssue(db, 704)];
      const action = createPiAction(db, {
        action_type: "issue.cancel",
        expected_state_json: JSON.stringify(issueBatchExpectedState(issues)),
        id: "cancel-703-704",
        payload_json: JSON.stringify({ issue_ids: [703, 704], status: "cancelled" }),
        project_id: "demo",
        status: "pending"
      });

      expect(evaluatePiActionFreshness(db, action)).toEqual({ fresh: true });
      db.sqlite.run("update issues set status='done', updated_at=? where id=704", ["2026-01-02T00:00:00Z"]);
      expect(evaluatePiActionFreshness(db, action)).toEqual({
        fresh: false,
        reason: "target_issue_704:target_state_changed:triage->done"
      });
    } finally {
      db.close();
    }
  });

  test("revalidates Session identity, turn and revision before steer", async () => {
    const db = await fixture();
    try {
      const session = upsertAgentSession(db, {
        project_id: "demo",
        provider: "codex",
        provider_session_id: "thread-705",
        raw_ref: { provider_turn_id: "turn-old" },
        status: "running"
      });
      const action = createPiAction(db, {
        action_type: "session.steer",
        expected_state_json: JSON.stringify(sessionExpectedState(session)),
        id: "steer-705",
        payload_json: JSON.stringify({
          prompt: "adjust",
          provider: "codex",
          provider_session_id: "thread-705",
          session_key: "codex:thread-705"
        }),
        project_id: "demo",
        status: "pending"
      });

      expect(evaluatePiActionFreshness(db, action)).toEqual({ fresh: true });
      db.sqlite.run("update agent_sessions set raw_ref=?, updated_at=? where session_key=?", [
        JSON.stringify({ provider_turn_id: "turn-new" }),
        "2026-01-02T00:00:00Z",
        session.session_key
      ]);
      expect(evaluatePiActionFreshness(db, action)).toEqual({
        fresh: false,
        reason: "target_session_provider_turn_id_changed:turn-old->turn-new"
      });
    } finally {
      db.close();
    }
  });

  test("gives every pending approval a bounded lease and expires it", async () => {
    const db = await fixture();
    try {
      insertIssue(db, 706, "triage");
      const issue = requireIssue(db, 706);
      const result = createPendingPiAction(db, {}, {
        actionType: "issue.enqueue",
        issueID: issue.id,
        payload: { expected_state: issueEnqueueExpectedState(issue), issue_id: issue.id },
        projectID: issue.project_id
      }) as { action_id: string; status: string };
      const pending = getPiAction(db, result.action_id);

      expect(result.status).toBe("pending");
      expect(pending?.lease_expires_at).not.toBe("");
      const afterLease = new Date(Date.parse(pending?.lease_expires_at ?? "") + 1);
      expect(expirePendingPiActionApprovals(db, afterLease)).toBe(1);
      expect(getPiAction(db, result.action_id)).toMatchObject({
        decided_by: "system:approval_ttl",
        status: "rejected"
      });
    } finally {
      db.close();
    }
  });

  test("revalidates revisioned Work control actions", async () => {
    const db = await fixture();
    try {
      insertIssue(db, 707, "triage");
      const workID = "xw:work:issues:707" as const;
      const work = getIssueAsWork(db, 707);
      if (!work) throw new Error("missing Work projection");
      const action = createPiAction(db, {
        action_type: "work.cancel",
        expected_state_json: JSON.stringify({ revision: work.revision }),
        id: "work-cancel-707",
        issue_id: 707,
        payload_json: JSON.stringify({
          action: "cancel",
          expected_revision: work.revision,
          work_id: workID
        }),
        project_id: "demo",
        status: "pending"
      });

      expect(evaluatePiActionFreshness(db, action)).toEqual({ fresh: true });
      db.sqlite.run("update issues set updated_at=? where id=707", ["2026-01-02T00:00:00Z"]);
      const revised = getIssueAsWork(db, 707);
      if (!revised) throw new Error("missing revised Work projection");
      expect(evaluatePiActionFreshness(db, action)).toEqual({
        fresh: false,
        reason: `target_work_revision_changed:${work.revision}->${revised.revision}`
      });
    } finally {
      db.close();
    }
  });
});

async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-action-freshness-"));
  roots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    "insert into projects (id,name,cwd,provider,provider_config_json,created_at,updated_at) values (?,?,?,?,?,?,?)",
    ["demo", "Demo", "/tmp/demo", "codex", '{"capabilities":["issue_execution"]}',
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  return db;
}

function insertIssue(db: RunnerDatabase, id: number, status: string): void {
  db.sqlite.run(
    "insert into issues (id,project_id,title,status,created_at,updated_at) values (?,'demo',?,?,?,?)",
    [id, `Issue ${id}`, status, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertRun(
  db: RunnerDatabase,
  issueID: number,
  id: string,
  status: string,
  endedAt: string,
  attemptRevision: number
): void {
  db.sqlite.run(`insert into issue_runs
    (id,issue_id,attempt,status,provider,provider_session_id,provider_turn_id,started_at,ended_at)
    values (?,?,1,?,'codex','thread-701','turn-701',?,?)`, [
    id, issueID, status, "2026-01-01T00:10:00Z", endedAt
  ]);
  db.sqlite.run("update run_attempts set revision=? where issue_run_id=?", [attemptRevision, id]);
}

function requireIssue(db: RunnerDatabase, id: number) {
  const issue = getIssue(db, id);
  if (!issue) throw new Error(`missing issue ${id}`);
  return issue;
}
