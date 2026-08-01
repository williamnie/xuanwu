import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { createIssueRun } from "../db/repositories/issueRuns.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { createPiAction } from "../db/repositories/pi.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { createHumanReviewRequest } from "../domain/review/humanReview.ts";
import { writeBackVerifierWorkflowEvidence } from "./verifierWorkflowWriteback.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("verifier workflow Evidence writeback", () => {
  test("promotes legacy verifier facts but leaves completion to PI semantic acceptance", async () => {
    const db = await fixture();
    try {
      const parent = issueWithEndedRun(db, {
        status: "pending_verification",
        title: "Parent delivery"
      });
      const child = issueWithEndedRun(db, {
        status: "done",
        title: `Verifier: #${parent.id}`,
        workflow_snapshot_json: JSON.stringify({
          agent_role: "verifier",
          parent_issue_id: parent.id
        })
      });
      authorizeVerifierCarrier(db, parent.id, child);
      insertPassedTestEvent(db, child.id);

      const result = await writeBackVerifierWorkflowEvidence(db, child.id, {
        now: new Date("2026-07-31T07:00:00Z")
      });

      expect(result).toEqual({
        evidence: 1,
        parent_issue_id: parent.id,
        status: "completed"
      });
      expect(getIssue(db, parent.id)).toMatchObject({ error: "", status: "pending_verification" });
      expect(listIssueEvents(db, parent.id, {
        types: ["evidence.recorded.v1", "issue.verifier_evidence_promoted.v1", "issue.pi_acceptance_requested.v1"]
      }).map((event) => event.type)).toEqual([
        "evidence.recorded.v1",
        "issue.verifier_evidence_promoted.v1",
        "issue.pi_acceptance_requested.v1"
      ]);
      const evidenceEvent = listIssueEvents(db, parent.id, {
        limit: 1,
        types: ["evidence.recorded.v1"]
      })[0];
      expect(JSON.parse(evidenceEvent?.payload ?? "{}")).toMatchObject({
        evidence: {
          decisive_output: {
            facts: { verifier_child_issue_id: child.id }
          },
          kind: "test",
          run_id: `xw:run:issue_runs:issue-${parent.id}-attempt-1`,
          status: "passed",
          work_id: `xw:work:issues:${parent.id}`
        }
      });
    } finally {
      db.close();
    }
  });

  test("does not override an explicit human-owned decision request", async () => {
    const db = await fixture();
    try {
      const parent = issueWithEndedRun(db, {
        status: "pending_verification",
        title: "Parent decision"
      });
      createHumanReviewRequest(db, parent.id, {
        question: "是否接受这个产品取舍？"
      });
      const child = issueWithEndedRun(db, {
        status: "done",
        title: `Verifier: #${parent.id}`,
        workflow_snapshot_json: JSON.stringify({
          agent_role: "verifier",
          parent_issue_id: parent.id
        })
      });
      authorizeVerifierCarrier(db, parent.id, child);
      insertPassedTestEvent(db, child.id);

      const result = await writeBackVerifierWorkflowEvidence(db, child.id);

      expect(result).toMatchObject({ evidence: 0, status: "skipped" });
      expect(getIssue(db, parent.id)?.status).toBe("pending_verification");
    } finally {
      db.close();
    }
  });

  test("rejects an unaudited Issue that only claims to be a verifier carrier", async () => {
    const db = await fixture();
    try {
      const parent = issueWithEndedRun(db, {
        status: "pending_verification",
        title: "Protected parent"
      });
      const child = issueWithEndedRun(db, {
        status: "done",
        title: `Untrusted verifier: #${parent.id}`,
        workflow_snapshot_json: JSON.stringify({
          agent_role: "verifier",
          parent_issue_id: parent.id
        })
      });
      insertPassedTestEvent(db, child.id);

      const result = await writeBackVerifierWorkflowEvidence(db, child.id);

      expect(result).toMatchObject({ evidence: 0, parent_issue_id: 0, status: "not_verifier" });
      expect(getIssue(db, parent.id)?.status).toBe("pending_verification");
    } finally {
      db.close();
    }
  });

  test("discards a completed verifier carrier that produced no captured executable Evidence", async () => {
    const db = await fixture();
    try {
      const parent = issueWithEndedRun(db, {
        status: "pending_verification",
        title: "Parent awaiting autonomous verification"
      });
      const child = issueWithEndedRun(db, {
        status: "pending_verification",
        title: `Verifier: #${parent.id}`,
        workflow_snapshot_json: JSON.stringify({
          agent_role: "verifier",
          parent_issue_id: parent.id
        })
      });
      authorizeVerifierCarrier(db, parent.id, child);

      const result = await writeBackVerifierWorkflowEvidence(db, child.id);

      expect(result).toMatchObject({
        evidence: 0,
        parent_issue_id: parent.id,
        status: "discarded"
      });
      expect(getIssue(db, child.id)).toMatchObject({
        error: expect.stringContaining("discarded this internal attempt"),
        status: "cancelled"
      });
      expect(listIssueEvents(db, child.id, {
        types: ["issue.verifier_contract_failed.v1"]
      })).toHaveLength(1);
      expect(getIssue(db, parent.id)?.status).toBe("pending_verification");
    } finally {
      db.close();
    }
  });

  test("discards a verifier-reported failure before Guardian can escalate the internal child", async () => {
    const db = await fixture();
    try {
      const parent = issueWithEndedRun(db, {
        status: "pending_verification",
        title: "Parent awaiting retry"
      });
      const child = issueWithEndedRun(db, {
        status: "failed",
        title: `Verifier: #${parent.id}`,
        workflow_snapshot_json: JSON.stringify({
          agent_role: "verifier",
          parent_issue_id: parent.id
        })
      });
      authorizeVerifierCarrier(db, parent.id, child);

      const result = await writeBackVerifierWorkflowEvidence(db, child.id);

      expect(result.status).toBe("discarded");
      expect(getIssue(db, child.id)?.status).toBe("cancelled");
      expect(getIssue(db, parent.id)?.status).toBe("pending_verification");
    } finally {
      db.close();
    }
  });
});

async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-verifier-writeback-"));
  roots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
     values ('demo', 'Demo', ?, 'codex', 1, ?, ?)`,
    [root, "2026-07-31T05:00:00Z", "2026-07-31T05:00:00Z"]
  );
  return db;
}

function authorizeVerifierCarrier(
  db: RunnerDatabase,
  parentIssueID: number,
  child: ReturnType<typeof issueWithEndedRun>
): void {
  createPiAction(db, {
    id: `verifier-action-${child.id}`,
    action_type: "agent.workflow_request",
    gate_decision: "execute",
    issue_id: parentIssueID,
    payload_json: JSON.stringify({
      workflow_snapshot_json: child.workflow_snapshot_json
    }),
    project_id: child.project_id,
    result_json: JSON.stringify(child),
    status: "completed"
  });
}

function issueWithEndedRun(
  db: RunnerDatabase,
  input: {
    status: "done" | "failed" | "pending_verification";
    title: string;
    workflow_snapshot_json?: string;
  }
) {
  const issue = createIssue(db, {
    project_id: "demo",
    status: "in_progress",
    title: input.title,
    workflow_snapshot_json: input.workflow_snapshot_json
  });
  const run = createIssueRun(db, issue.id);
  db.sqlite.run(
    "update issue_runs set status='done', started_at=?, ended_at=? where id=?",
    ["2026-07-31T06:57:00Z", "2026-07-31T06:59:00Z", run.id]
  );
  return updateIssue(db, issue.id, { error: "", status: input.status });
}

function insertPassedTestEvent(db: RunnerDatabase, issueID: number): void {
  const runID = `xw:run:issue_runs:issue-${issueID}-attempt-1`;
  const rawPayload = JSON.stringify({
    item: {
      aggregatedOutput: "1 pass",
      command: "bun test verifier.test.ts",
      commandActions: [{ command: "bun test verifier.test.ts", type: "unknown" }],
      completedAtMs: Date.parse("2026-07-31T06:58:00Z"),
      durationMs: 10,
      exitCode: 0,
      id: `command-${issueID}`,
      status: "completed",
      type: "commandExecution"
    }
  });
  db.sqlite.run(
    "insert into issue_events (issue_id, type, payload, created_at) values (?, 'issue.log', ?, ?)",
    [issueID, JSON.stringify({
      raw_method: "item/completed",
      raw_payload: rawPayload,
      runtime_evidence_correlation: {
        attempt_id: `${runID}~attempt:1`,
        contract: "xw.runtime-evidence-correlation.v1",
        issue_run_id: `issue-${issueID}-attempt-1`,
        provider: "codex",
        provider_session_id: `thread-${issueID}`,
        provider_turn_id: `turn-${issueID}`,
        run_id: runID
      },
      type: "tool"
    }), "2026-07-31T06:58:00Z"]
  );
}
