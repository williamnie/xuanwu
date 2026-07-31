import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { createIssueRun, updateIssueRuntime } from "../db/repositories/issueRuns.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { pausePiHeartbeat } from "../db/repositories/pi.ts";
import { createHumanReviewRequest, readIssueVerificationProjection } from "../domain/review/humanReview.ts";
import type { PiAcceptanceRuntimeResult } from "../pi/issueAcceptance.ts";
import type { ExecutorProvider, ProviderRecoveryInput, ProviderRunInput, ProviderRunResult } from "../providers/types.ts";
import { runPiVerificationCoordinatorOnce } from "./piVerificationCoordinator.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("issue-scoped PI acceptance coordinator", () => {
  test("calls PI once with a bounded completion card and accepts without a Verifier Issue", async () => {
    const db = await fixture();
    try {
      const issue = completedIssue(db, "Delivery");
      const seen: Array<{ issue: number; commands: number }> = [];
      const result = await runPiVerificationCoordinatorOnce({
        database: db,
        decideIssueAcceptance: async (card) => {
          seen.push({ issue: card.issue.id, commands: card.commands.total });
          return acceptance("accept");
        }
      });

      expect(result).toEqual({ failed: 0, issues: 1, projects: 1, skipped: 0, started: 1 });
      expect(seen).toEqual([{ issue: issue.id, commands: 0 }]);
      expect(getIssue(db, issue.id)?.status).toBe("done");
      expect(db.sqlite.query<{ count: number }, []>("select count(*) as count from issues").get()?.count).toBe(1);
      expect(eventTypes(db, issue.id)).toEqual(expect.arrayContaining([
        "issue.completion_card.v1",
        "issue.pi_acceptance_decision.v1",
        "issue.pi_acceptance_applied.v1",
        "evidence.recorded.v1"
      ]));
    } finally {
      db.close();
    }
  });

  test("does not launch PI acceptance while a human review request is open", async () => {
    const db = await fixture();
    let calls = 0;
    try {
      const issue = completedIssue(db, "Needs product choice");
      createHumanReviewRequest(db, issue.id, { question: "是否接受当前范围？" });
      const result = await runPiVerificationCoordinatorOnce({
        database: db,
        decideIssueAcceptance: async () => { calls += 1; return acceptance("accept"); }
      });
      expect(result).toMatchObject({ issues: 0, projects: 0, started: 0 });
      expect(calls).toBe(0);
    } finally {
      db.close();
    }
  });

  test("respects an explicit project heartbeat pause", async () => {
    const db = await fixture();
    let calls = 0;
    try {
      completedIssue(db, "Paused");
      pausePiHeartbeat(db, { reason: "maintenance", scopeId: "demo", scopeType: "project" });
      const result = await runPiVerificationCoordinatorOnce({
        database: db,
        decideIssueAcceptance: async () => { calls += 1; return acceptance("accept"); }
      });
      expect(result).toMatchObject({ issues: 0, started: 0 });
      expect(calls).toBe(0);
    } finally {
      db.close();
    }
  });

  test("opens a human review after two failures for the same card instead of retrying forever", async () => {
    const db = await fixture();
    let calls = 0;
    try {
      const issue = completedIssue(db, "Broken PI RPC");
      const run = () => runPiVerificationCoordinatorOnce({
        cooldownMs: 0,
        database: db,
        decideIssueAcceptance: async () => {
          calls += 1;
          throw new Error("agentic RPC unavailable");
        },
        now: new Date(`2026-07-31T05:0${calls}:30Z`)
      });
      expect((await run()).failed).toBe(1);
      expect((await run()).failed).toBe(1);
      expect(calls).toBe(2);
      expect(readIssueVerificationProjection(db, issue.id)).toMatchObject({ owner: "human", phase: "human_review" });
      expect(eventTypes(db, issue.id).filter((type) => type === "issue.pi_verification_started.v1")).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test("also circuit-breaks repeated completion-card construction failures", async () => {
    const db = await fixture();
    let calls = 0;
    try {
      const issue = createIssue(db, { project_id: "demo", status: "pending_verification", title: "Missing terminal Run" });
      const run = () => runPiVerificationCoordinatorOnce({
        cooldownMs: 0,
        database: db,
        decideIssueAcceptance: async () => { calls += 1; return acceptance("accept"); },
        now: new Date("2026-07-31T05:10:00Z")
      });

      expect((await run()).failed).toBe(1);
      expect((await run()).failed).toBe(1);
      expect(calls).toBe(0);
      expect(readIssueVerificationProjection(db, issue.id)).toMatchObject({ owner: "human", phase: "human_review" });
    } finally {
      db.close();
    }
  });

  test("re-evaluates the fresh card after same-session continuation finishes", async () => {
    const db = await fixture();
    const provider = new CoordinatorContinuationProvider();
    let calls = 0;
    try {
      const issue = completedIssue(db, "Continue then accept");
      const firstRun = listIssueRuns(db, issue.id)[0]!;
      updateIssueRuntime(db, issue.id, {
        issue_run_id: firstRun.id,
        provider: "codex",
        provider_session_id: "session-original",
        provider_turn_id: "turn-original"
      });
      const decide = async (): Promise<PiAcceptanceRuntimeResult> => {
        calls += 1;
        return calls === 1
          ? {
            decision: {
              confidence: "high",
              decision: "continue_same_session",
              evidence_refs: ["run:fixture"],
              follow_up_prompt: "补一项真实验证。",
              rationale: "还缺少一项验证。",
              unmet_requirements: ["真实验证"]
            },
            raw_text: "{}",
            valid: true
          }
          : acceptance("accept");
      };

      await runPiVerificationCoordinatorOnce({
        cooldownMs: 0,
        database: db,
        decideIssueAcceptance: decide,
        providers: { codex: provider }
      });
      expect(getIssue(db, issue.id)?.status).toBe("pending_verification");
      await runPiVerificationCoordinatorOnce({
        cooldownMs: 0,
        database: db,
        decideIssueAcceptance: decide,
        providers: { codex: provider }
      });

      expect(calls).toBe(2);
      expect(getIssue(db, issue.id)?.status).toBe("done");
      expect(listIssueRuns(db, issue.id)).toHaveLength(2);
      expect(provider.inputs[0]?.session.sessionId).toBe("session-original");
      expect(db.sqlite.query<{ count: number }, []>("select count(*) as count from issues").get()?.count).toBe(1);
    } finally {
      db.close();
    }
  });
});

class CoordinatorContinuationProvider implements ExecutorProvider {
  readonly capabilities = ["issue_execution", "resume_session"] as const;
  readonly id = "codex" as const;
  readonly inputs: ProviderRecoveryInput[] = [];

  async run(_input: ProviderRunInput): Promise<ProviderRunResult> {
    throw new Error("run must not be called");
  }

  async recover(input: ProviderRecoveryInput): Promise<ProviderRunResult> {
    this.inputs.push(input);
    const session = { provider: this.id, sessionId: input.session.sessionId, turnId: "turn-next" };
    input.onEvent?.({ provider: this.id, session, text: "补充完成。\nRUNNER_OUTCOME: completed", type: "text" });
    input.onEvent?.({
      provider: this.id,
      raw: { method: "turn/completed", payload: JSON.stringify({ turn: { id: "turn-next", status: "completed" } }) },
      session,
      status: "completed",
      type: "done"
    });
    return { runId: "codex:session-original:turn-next", session };
  }
}

function acceptance(decision: "accept" | "needs_user"): PiAcceptanceRuntimeResult {
  return {
    decision: {
      confidence: "high",
      decision,
      evidence_refs: ["run:fixture"],
      rationale: decision === "accept" ? "当前 Run 的事实满足 Issue。" : "需要用户决定。",
      unmet_requirements: []
    },
    raw_text: "{}",
    valid: true
  };
}

async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-acceptance-"));
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

function completedIssue(db: RunnerDatabase, title: string) {
  const issue = createIssue(db, { project_id: "demo", status: "pending_verification", title });
  const run = createIssueRun(db, issue.id);
  db.sqlite.run(
    "update issue_runs set status='done', ended_at=? where id=?",
    ["2026-07-31T05:01:00Z", run.id]
  );
  return issue;
}

function eventTypes(db: RunnerDatabase, issueID: number): string[] {
  return listIssueEvents(db, issueID).map((event) => event.type);
}
