import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { getIssue } from "../../db/repositories/issues.ts";
import { listStoredEvidence } from "../../db/repositories/evidence.ts";
import { listStoredHandoffs } from "../../db/repositories/handoffs.ts";
import { validateWorkflowVerificationPolicy } from "./policy.ts";
import { parseStructuredVerifierReviewEventPayload } from "./verifierReview.ts";
import { recordIssueRunGitWorkspaceBaseline } from "./runGitWorkspaceBaseline.ts";
import {
  classifyVerificationCommand,
  completeIssueFromRuntimeEvidence,
  ISSUE_VERIFICATION_GATE_EVENT_TYPES,
  ISSUE_WORK_VERIFICATION_POLICY,
  reconcileIssueCompletionFromRuntimeEvidence,
  runtimeVerificationGap
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
    expect(classifyVerificationCommand("node --test src/api/example.test.js")).toBe("test");
    expect(classifyVerificationCommand("flutter analyze")).toBe("lint");
    expect(classifyVerificationCommand("cargo build --release")).toBe("build");
    expect(classifyVerificationCommand("bun test a.test.ts && git diff --check")).toBe("test");
    expect(classifyVerificationCommand("rg -n 'legacy' src && bun test a.test.ts")).toBe("test");
    expect(classifyVerificationCommand("sed -n '1,20p' policy.test.ts")).toBeUndefined();
    expect(classifyVerificationCommand("bun test a.test.ts\nbunx tsc --noEmit")).toBeUndefined();
    expect(classifyVerificationCommand("bun test a.test.ts | cat")).toBeUndefined();
    expect(classifyVerificationCommand("echo $(date) && bun test a.test.ts")).toBeUndefined();
    expect(classifyVerificationCommand("zsh -lc 'bun test a.test.ts'")).toBeUndefined();
  });

  test("correlates PTY terminal interactions with the completed command without treating stdin as proof", async () => {
    const db = await fixture();
    try {
      const issueID = insertRunningIssue(db);
      prepareDirtyRepository(db);
      insertTerminalInteraction(db, issueID, "command-pty", "process-pty");
      insertCommandEvent(db, issueID, "bun test src/domain/evidence/completionGate.test.ts", 0, {
        correlation: runtimeCorrelation(issueID, 1),
        itemID: "command-pty",
        processID: "process-pty"
      });

      const result = await completeIssueFromRuntimeEvidence(db, issueID, { status: "done" });
      const records = listStoredEvidence(db, { issue_ids: [issueID], limit: 10 }).items;

      expect(result.issue.status).toBe("done");
      expect(records).toHaveLength(2);
      const verification = records.find((item) => item.evidence.kind === "test")?.evidence;
      expect(verification?.decisive_output.facts).toMatchObject({
        correlation_channel: "terminal_interaction",
        terminal_interaction_count: 1
      });
      expect(JSON.stringify(verification)).not.toContain("typed-but-not-proof");
      expect(listStoredHandoffs(db, {
        limit: 10,
        work_id: `xw:work:issues:${issueID}`
      }).items).toMatchObject([{
        handoff: {
          evidence_ids: expect.arrayContaining(records.map((item) => item.evidence.id)),
          run_ids: [`xw:run:issue_runs:issue-${issueID}-attempt-1`],
          status: "ready"
        }
      }]);
    } finally {
      db.close();
    }
  });

  test("projects current-Run Evidence from Codex unified exec dynamic tool output", async () => {
    const db = await fixture();
    try {
      const issueID = insertRunningIssue(db);
      prepareDirtyRepository(db);
      insertDynamicExecEvent(db, issueID, "node --test src/api/example.test.js", 0, {
        correlation: runtimeCorrelation(issueID, 1)
      });

      const result = await completeIssueFromRuntimeEvidence(db, issueID, { status: "done" });
      const records = listStoredEvidence(db, { issue_ids: [issueID], limit: 10 }).items;

      expect(result.issue.status).toBe("done");
      expect(records.find((item) => item.evidence.kind === "test")?.evidence).toMatchObject({
        run_id: `xw:run:issue_runs:issue-${issueID}-attempt-1`,
        status: "passed",
        decisive_output: { facts: { command: "node --test src/api/example.test.js", outcome: "passed" } }
      });
    } finally {
      db.close();
    }
  });

  test("rejects a late command correlated to an older Run instead of polluting the current Run", async () => {
    const db = await fixture();
    try {
      const issueID = insertRunningIssue(db);
      const now = new Date();
      db.sqlite.run("update issue_runs set status='failed', ended_at=? where issue_id=?", [new Date(now.getTime() - 2_000).toISOString(), issueID]);
      db.sqlite.run(
        `insert into issue_runs (id, issue_id, attempt, status, provider, started_at)
         values (?, ?, 2, 'in_progress', 'codex', ?)`,
        [`issue-${issueID}-attempt-2`, issueID, new Date(now.getTime() - 1_000).toISOString()]
      );
      insertCommandEvent(db, issueID, "bun test src/domain/evidence/completionGate.test.ts", 0, {
        correlation: runtimeCorrelation(issueID, 1)
      });

      const result = await completeIssueFromRuntimeEvidence(db, issueID, { status: "done" }, { now: now.toISOString() });

      expect(result.issue.status).toBe("pending_verification");
      expect(result.evaluation.groups[0]?.requirements[0]).toMatchObject({ status: "missing" });
      expect(listStoredEvidence(db, { issue_ids: [issueID], limit: 10 }).items).toHaveLength(0);
      expect(await runtimeVerificationGap(db, issueID, now.toISOString())).toMatchObject({ reason: "run_mismatch" });
    } finally {
      db.close();
    }
  });

  test("reports an unsafe compound verification as not captured instead of auto-accepting it", async () => {
    const db = await fixture();
    try {
      const issueID = insertRunningIssue(db);
      insertCommandEvent(db, issueID, "bun test a.test.ts | cat", 0);

      expect(await runtimeVerificationGap(db, issueID)).toMatchObject({ reason: "not_captured" });
    } finally {
      db.close();
    }
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
      prepareDirtyRepository(db);
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
      expect(listStoredHandoffs(db, { limit: 10, work_id: `xw:work:issues:${issueID}` }).items).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("lets a later passing chained test supersede an earlier failed lint result", async () => {
    const db = await fixture();
    try {
      const issueID = insertRunningIssue(db);
      prepareDirtyRepository(db);
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

  test("reconciles a historical failed Issue from passed Evidence and a committed Git delivery", async () => {
    const db = await fixture();
    try {
      const issueID = insertRunningIssue(db);
      const revisions = prepareHistoricalCommittedRepository(db, issueID);
      insertCommandEvent(db, issueID, "bun test src/domain/evidence/completionGate.test.ts", 0, {
        correlation: runtimeCorrelation(issueID, 1)
      });
      db.sqlite.run(
        `update issue_runs set status='pending_verification', ended_at=? where issue_id=?`,
        ["2026-01-01T00:15:00Z", issueID]
      );
      db.sqlite.run(
        `update issues set status='failed', error='implementation complete; Handoff missing' where id=?`,
        [issueID]
      );

      const result = await reconcileIssueCompletionFromRuntimeEvidence(db, issueID);
      const handoff = listStoredHandoffs(db, {
        limit: 10,
        work_id: `xw:work:issues:${issueID}`
      }).items[0]?.handoff;

      expect(result).toMatchObject({
        evaluation: { decision: "passed", satisfied: true },
        issue: { status: "done", error: "" },
        target_status: "done",
        transition_path: ["failed->pending_verification", "pending_verification->done"]
      });
      expect(handoff).toMatchObject({
        baseline_revision: revisions.baseline,
        changed_files: ["result.txt"],
        run_ids: [`xw:run:issue_runs:issue-${issueID}-attempt-1`],
        status: "ready"
      });
    } finally {
      db.close();
    }
  });

  test("does not reopen a failed Issue when current-Run Evidence is not passed", async () => {
    const db = await fixture();
    try {
      const issueID = insertRunningIssue(db);
      prepareDirtyRepository(db);
      db.sqlite.run(
        `update issue_runs set status='failed', ended_at=? where issue_id=?`,
        [new Date().toISOString(), issueID]
      );
      db.sqlite.run("update issues set status='failed', error='executor failed' where id=?", [issueID]);

      await expect(reconcileIssueCompletionFromRuntimeEvidence(db, issueID))
        .rejects.toThrow("requires passed current-Run Evidence");
      expect(getIssue(db, issueID)).toMatchObject({ status: "failed", error: "executor failed" });
      expect(listStoredHandoffs(db, {
        limit: 10,
        work_id: `xw:work:issues:${issueID}`
      }).items).toHaveLength(0);
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

function prepareDirtyRepository(db: RunnerDatabase): void {
  const repository = db.sqlite.query<{ cwd: string }, []>("select cwd from projects where id='demo'").get()?.cwd;
  if (!repository) throw new Error("missing fixture project cwd");
  mkdirSync(repository, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repository });
  writeFileSync(join(repository, "baseline.txt"), "baseline\n");
  execFileSync("git", ["add", "baseline.txt"], { cwd: repository });
  execFileSync("git", [
    "-c", "user.name=Runner Test", "-c", "user.email=runner@example.invalid",
    "commit", "-qm", "baseline"
  ], { cwd: repository });
  const baseRevision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8"
  }).trim();
  const run = db.sqlite.query<{ id: string }, []>(
    "select id from issue_runs order by started_at desc limit 1"
  ).get();
  if (!run) throw new Error("missing fixture issue run");
  const capturedAt = new Date().toISOString();
  db.sqlite.run(
    "update issue_runs set git_base_revision=?, started_at=? where id=?",
    [baseRevision, capturedAt, run.id]
  );
  const issueID = db.sqlite.query<{ issue_id: number }, [string]>(
    "select issue_id from issue_runs where id=?"
  ).get(run.id)?.issue_id;
  if (!issueID) throw new Error("missing fixture issue");
  recordIssueRunGitWorkspaceBaseline(db, issueID, {
    base_revision: baseRevision,
    captured_at: capturedAt,
    repository_path: repository,
    run_id: run.id
  });
  writeFileSync(join(repository, "result.txt"), "actual delivery artifact\n");
}

function prepareHistoricalCommittedRepository(
  db: RunnerDatabase,
  issueID: number
): { baseline: string; final: string } {
  const repository = db.sqlite.query<{ cwd: string }, []>("select cwd from projects where id='demo'").get()?.cwd;
  if (!repository) throw new Error("missing fixture project cwd");
  mkdirSync(repository, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repository });
  writeFileSync(join(repository, "baseline.txt"), "baseline\n");
  execFileSync("git", ["add", "baseline.txt"], { cwd: repository });
  commitAt(repository, "baseline", "2026-01-01T00:00:00Z");
  const baseline = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
  db.sqlite.run(
    "update issue_runs set started_at='2026-01-01T00:05:00Z', git_base_revision='' where issue_id=?",
    [issueID]
  );
  writeFileSync(join(repository, "result.txt"), "committed delivery artifact\n");
  execFileSync("git", ["add", "result.txt"], { cwd: repository });
  commitAt(repository, "result", "2026-01-01T00:10:00Z");
  const final = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
  writeFileSync(join(repository, "unrelated.txt"), "later unrelated delivery\n");
  execFileSync("git", ["add", "unrelated.txt"], { cwd: repository });
  commitAt(repository, "unrelated", "2026-01-01T00:20:00Z");
  return { baseline, final };
}

function commitAt(repository: string, message: string, timestamp: string): void {
  execFileSync("git", [
    "-c", "user.name=Runner Test", "-c", "user.email=runner@example.invalid",
    "commit", "-qm", message
  ], {
    cwd: repository,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: timestamp,
      GIT_COMMITTER_DATE: timestamp
    }
  });
}

function insertCommandEvent(
  db: RunnerDatabase,
  issueID: number,
  command: string,
  exitCode: number,
  options: { correlation?: Record<string, unknown>; itemID?: string; processID?: string } = {}
): void {
  const completedAtMs = Date.now();
  const rawPayload = JSON.stringify({
    item: {
      type: "commandExecution",
      id: options.itemID ?? `command-${issueID}`,
      processId: options.processID,
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
    [issueID, JSON.stringify({
      type: "tool",
      raw_method: "item/completed",
      raw_payload: rawPayload,
      runtime_evidence_correlation: options.correlation
    }), new Date(completedAtMs).toISOString()]
  );
}

function insertDynamicExecEvent(
  db: RunnerDatabase,
  issueID: number,
  command: string,
  exitCode: number,
  options: { correlation?: Record<string, unknown> } = {}
): void {
  const completedAt = new Date().toISOString();
  const rawPayload = JSON.stringify({
    item: {
      type: "dynamicToolCall",
      id: `dynamic-${issueID}`,
      tool: "exec",
      status: "completed",
      success: true,
      durationMs: 10,
      arguments: `const r = await tools.exec_command(${JSON.stringify({
        cmd: command,
        workdir: "/tmp/demo"
      })});\ntext(r.output);\n`,
      contentItems: [{
        type: "inputText",
        text: exitCode === 0
          ? "Script completed\nWall time 0.1 seconds\nOutput:\n1 pass"
          : "Script failed\nWall time 0.1 seconds\nOutput:\n1 fail"
      }]
    }
  });
  db.sqlite.run(
    "insert into issue_events (issue_id, type, payload, created_at) values (?, 'issue.log', ?, ?)",
    [issueID, JSON.stringify({
      type: "tool",
      raw_method: "item/completed",
      raw_payload: rawPayload,
      runtime_evidence_correlation: options.correlation
    }), completedAt]
  );
}

function insertTerminalInteraction(db: RunnerDatabase, issueID: number, itemID: string, processID: string): void {
  const payload = JSON.stringify({
    itemId: itemID,
    processId: processID,
    stdin: "typed-but-not-proof",
    threadId: "thread-gate",
    turnId: "turn-gate"
  });
  db.sqlite.run(
    "insert into issue_events (issue_id, type, payload, created_at) values (?, 'issue.log', ?, ?)",
    [issueID, JSON.stringify({
      type: "tool",
      raw_method: "item/commandExecution/terminalInteraction",
      raw_payload: payload,
      runtime_evidence_correlation: runtimeCorrelation(issueID, 1)
    }), new Date(Date.now() - 1).toISOString()]
  );
}

function runtimeCorrelation(issueID: number, attempt: number): Record<string, unknown> {
  const runID = `xw:run:issue_runs:issue-${issueID}-attempt-${attempt}`;
  return {
    attempt_id: `${runID}~attempt:${attempt}`,
    contract: "xw.runtime-evidence-correlation.v1",
    issue_run_id: `issue-${issueID}-attempt-${attempt}`,
    provider: "codex",
    provider_session_id: "thread-gate",
    provider_turn_id: "turn-gate",
    run_id: runID
  };
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
