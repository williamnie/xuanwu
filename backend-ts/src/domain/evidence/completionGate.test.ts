import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { getIssue } from "../../db/repositories/issues.ts";
import { validateWorkflowVerificationPolicy } from "./policy.ts";
import { parseStructuredVerifierReviewEventPayload } from "./verifierReview.ts";
import {
  classifyVerificationCommand,
  completeIssueFromRuntimeEvidence,
  ISSUE_VERIFICATION_GATE_EVENT_TYPES,
  ISSUE_WORK_VERIFICATION_POLICY
} from "./completionGate.ts";

const tempRoots: string[] = [];
const ADR_PATH = resolve(import.meta.dir, "../../../../docs/architecture/xuanwu/0033-evidence-policy-completion-gate.md");

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Evidence Policy completion gate", () => {
  test("defines a valid Issue compatibility policy and only recognizes executable verification commands", () => {
    expect(validateWorkflowVerificationPolicy(ISSUE_WORK_VERIFICATION_POLICY)).toEqual({ errors: [], ok: true });
    expect(classifyVerificationCommand("bun test src/domain/evidence/completionGate.test.ts")).toBe("test");
    expect(classifyVerificationCommand("flutter analyze")).toBe("lint");
    expect(classifyVerificationCommand("cargo build --release")).toBe("build");
    expect(classifyVerificationCommand("bun test a.test.ts && git diff --check")).toBe("test");
    expect(classifyVerificationCommand("rg -n 'legacy' src && bun test a.test.ts")).toBe("test");
    expect(classifyVerificationCommand("sed -n '1,20p' policy.test.ts")).toBeUndefined();
    expect(classifyVerificationCommand("bun test a.test.ts\nbunx tsc --noEmit")).toBeUndefined();
    expect(classifyVerificationCommand("bun test a.test.ts | cat")).toBeUndefined();
  });

  test("documents authority, compatibility window, rollback and deletion gates", () => {
    const adr = readFileSync(ADR_PATH, "utf8");
    expect(adr).toContain("`issues` 仍是 Work status write authority");
    expect(adr).toContain("最多两个正式 release window");
    expect(adr).toContain("回滚");
    expect(adr).toContain("P11.03/P11.06");
    expect(adr).toContain("legacy verifier report");
  });

  test("maps a decisive failed test to failed/needs-attention with an audited policy outcome", async () => {
    const db = await fixture();
    try {
      const issueID = insertRunningIssue(db);
      insertCommandEvent(db, issueID, "bun test src/domain/evidence/completionGate.test.ts", 1);

      const result = await completeIssueFromRuntimeEvidence(db, issueID, { status: "done", error: "" }, {
        now: new Date().toISOString()
      });
      const events = gateEvents(db, issueID);
      const outcome = JSON.parse(events.at(-1)?.payload ?? "{}") as Record<string, unknown>;
      const review = latestVerifierReview(db, issueID);

      expect(result).toMatchObject({
        evaluation: { decision: "failed", satisfied: false },
        issue: { status: "failed", error: expect.stringContaining("Verification failed") },
        target_status: "failed",
        transition_path: ["in_progress->failed"]
      });
      expect(outcome).toMatchObject({
        evaluation: { decision: "failed" },
        target_status: "failed",
        transition_path: ["in_progress->failed"]
      });
      expect(review).toMatchObject({
        verdict: "fail",
        recommended_next_action: { action: "fix_and_reverify" },
        gate_consistency: { expected_status: "failed", policy_decision: "failed" }
      });
    } finally {
      db.close();
    }
  });

  test("lets a later passing chained test supersede an earlier failed lint result", async () => {
    const db = await fixture();
    try {
      const issueID = insertRunningIssue(db);
      insertCommandEvent(db, issueID, "bunx tsc -p tsconfig.json --noEmit", 1);
      insertCommandEvent(db, issueID, "bun test src/xuanwu/userFacingTerminology.test.ts && git diff --check", 0);

      const result = await completeIssueFromRuntimeEvidence(db, issueID, { status: "done", error: "" });

      expect(result).toMatchObject({
        evaluation: {
          decision: "passed",
          groups: [{ requirements: [{ status: "passed" }], status: "passed" }]
        },
        issue: { status: "done", error: "" },
        target_status: "done"
      });
    } finally {
      db.close();
    }
  });

  test("does not upgrade a legacy verifier report or Agent narrative into completion Evidence", async () => {
    const db = await fixture();
    try {
      const issueID = insertRunningIssue(db);
      db.sqlite.run(
        "insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)",
        [issueID, "issue.verification_report", JSON.stringify({ recommendation: "accept", summary: "tests passed" }), new Date().toISOString()]
      );
      db.sqlite.run(
        "insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)",
        [issueID, "issue.comment", JSON.stringify({ author: "agent", body: "I verified everything" }), new Date().toISOString()]
      );

      const result = await completeIssueFromRuntimeEvidence(db, issueID, { status: "done", error: "" });

      expect(result).toMatchObject({
        evaluation: { decision: "pending", satisfied: false },
        issue: { status: "pending_verification" },
        target_status: "pending_verification"
      });
      expect(getIssue(db, issueID)?.status).toBe("pending_verification");
      expect(gateEvents(db, issueID).map((event) => event.type)).toEqual([
        ISSUE_VERIFICATION_GATE_EVENT_TYPES.intent,
        ISSUE_VERIFICATION_GATE_EVENT_TYPES.outcome
      ]);
      expect(latestVerifierReview(db, issueID)).toMatchObject({
        verdict: "inconclusive",
        missing_evidence: [expect.objectContaining({ requirement_id: "current-run-check" })],
        gate_consistency: { expected_status: "pending_verification", policy_decision: "pending" }
      });
    } finally {
      db.close();
    }
  });
});

async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-completion-gate-"));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    ["demo", "demo", join(root, "project"), "codex", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  return db;
}

function insertRunningIssue(db: RunnerDatabase): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, codex_thread_id, codex_turn_id, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    ["demo", "Completion gate", "in_progress", "thread-gate", "turn-gate", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const issueID = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id;
  if (!issueID) throw new Error("missing issue id");
  db.sqlite.run(
    `insert into issue_runs (id, issue_id, attempt, status, provider, started_at)
     values (?, ?, ?, ?, ?, ?)`,
    [`issue-${issueID}-attempt-1`, issueID, 1, "in_progress", "codex", "2026-01-01T00:00:00Z"]
  );
  return issueID;
}

function insertCommandEvent(db: RunnerDatabase, issueID: number, command: string, exitCode: number): void {
  const completedAtMs = Date.now();
  const rawPayload = JSON.stringify({
    item: {
      type: "commandExecution",
      id: `command-${issueID}`,
      command,
      cwd: "/tmp/demo",
      status: exitCode === 0 ? "completed" : "failed",
      commandActions: [{ type: "unknown", command }],
      aggregatedOutput: "focused verification",
      exitCode,
      durationMs: 10,
      completedAtMs
    }
  });
  db.sqlite.run(
    "insert into issue_events (issue_id, type, payload, created_at) values (?, 'issue.log', ?, ?)",
    [issueID, JSON.stringify({ type: "tool", raw_method: "item/completed", raw_payload: rawPayload }), new Date(completedAtMs).toISOString()]
  );
}

function gateEvents(db: RunnerDatabase, issueID: number): Array<{ payload: string; type: string }> {
  return db.sqlite.query<{ payload: string; type: string }, [number, string, string]>(`
    select payload, type from issue_events
    where issue_id=? and type in (?, ?) order by id
  `).all(issueID, ISSUE_VERIFICATION_GATE_EVENT_TYPES.intent, ISSUE_VERIFICATION_GATE_EVENT_TYPES.outcome);
}

function latestVerifierReview(db: RunnerDatabase, issueID: number) {
  const payload = db.sqlite.query<{ payload: string }, [number]>(`
    select payload from issue_events
    where issue_id=? and type='issue.verification_report' order by id desc limit 1
  `).get(issueID)?.payload;
  return parseStructuredVerifierReviewEventPayload(payload);
}
