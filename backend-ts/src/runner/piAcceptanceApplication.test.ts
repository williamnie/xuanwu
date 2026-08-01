import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { createIssueRun, updateIssueRuntime } from "../db/repositories/issueRuns.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { buildIssueCompletionCard, recordIssueCompletionCard } from "../domain/acceptance/completionCard.ts";
import {
  createHumanReviewRequest,
  readIssueDecisionProjection,
  reviewHumanIssue
} from "../domain/review/humanReview.ts";
import type { PiAcceptanceDecision } from "../pi/issueAcceptance.ts";
import { diagnoseIssueState } from "../pi/issueStateManager.ts";
import type {
  ExecutorProvider,
  ProviderRecoveryInput,
  ProviderRunInput,
  ProviderRunResult
} from "../providers/types.ts";
import { applyPiAcceptanceDecision } from "./piAcceptanceApplication.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("PI acceptance decision application", () => {
  test("accepts the exact current card, persists semantic acceptance, and is idempotent", async () => {
    const db = await fixture();
    try {
      const issue = completedIssue(db, "Accept delivery");
      const card = await buildIssueCompletionCard(db, issue.id);
      const first = await applyPiAcceptanceDecision({ database: db }, card, decision("accept"));
      const replay = await applyPiAcceptanceDecision({ database: db }, card, decision("accept"));

      expect(first.status).toBe("done");
      expect(replay.status).toBe("done");
      expect(db.sqlite.query<{ count: number }, [number]>(
        "select count(*) as count from issue_events where issue_id=? and type='issue.pi_acceptance_applied.v1'"
      ).get(issue.id)?.count).toBe(1);
      expect(diagnoseIssueState(db, { includeDoneIssues: true, issueIDs: [issue.id] }).diagnostics).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("acceptance depends on PI's Session judgment, not Handoff artifacts", async () => {
    const db = await fixture();
    try {
      const issue = completedIssue(db, "Required handoff");
      const card = await buildIssueCompletionCard(db, issue.id);

      const accepted = await applyPiAcceptanceDecision({ database: db }, card, decision("accept"));
      expect(accepted.status).toBe("done");
    } finally {
      db.close();
    }
  });

  test("PI can hold the Issue for one explicit human decision", async () => {
    const db = await fixture();
    try {
      const issue = completedIssue(db, "Need product choice");
      const card = await buildIssueCompletionCard(db, issue.id);
      const updated = await applyPiAcceptanceDecision(
        { database: db },
        card,
        decision("needs_user", "请确认是否接受这个范围取舍。")
      );

      expect(updated.status).toBe("needs_user");
      expect(readIssueDecisionProjection(db, issue.id)).toMatchObject({
        owner: "human",
        phase: "human_review",
        request: { question: "需要在原 Session 补充明确工作。" }
      });
    } finally {
      db.close();
    }
  });

  test("PI retry creates a fresh Provider Session and a new canonical Run", async () => {
    const db = await fixture();
    const provider = new FreshSessionProvider();
    try {
      const issue = completedIssue(db, "Retry delivery", "session-broken", "turn-broken");
      const card = await buildIssueCompletionCard(db, issue.id);
      const updated = await applyPiAcceptanceDecision(
        { database: db, providers: { codex: provider } },
        card,
        decision("retry", "原 Session 已损坏，读取工作区后从剩余步骤继续。")
      );

      expect(provider.inputs).toHaveLength(1);
      expect(provider.inputs[0]?.prompt).toContain("原 Session 已损坏");
      expect(provider.inputs[0]?.prompt).toContain("新 Session");
      expect(updated.status).toBe("in_progress");
      expect(listIssueRuns(db, issue.id)).toMatchObject([
        { attempt: 1, provider_session_id: "session-broken" },
        { attempt: 2, provider_session_id: "session-fresh", provider_turn_id: "turn-fresh", status: "succeeded" }
      ]);
    } finally {
      db.close();
    }
  });

  test("continues in the same Provider Session and creates a new canonical Run", async () => {
    const db = await fixture();
    const provider = new ContinuingProvider();
    try {
      const issue = completedIssue(db, "Continue delivery", "session-original", "turn-original");
      const card = await buildIssueCompletionCard(db, issue.id);
      const updated = await applyPiAcceptanceDecision(
        { database: db, providers: { codex: provider } },
        card,
        decision("continue_same_session", "补充 Node 22 下的完整回归并报告退出码。")
      );

      expect(provider.inputs).toHaveLength(1);
      expect(provider.inputs[0]).toMatchObject({
        issueId: issue.id,
        session: { provider: "codex", sessionId: "session-original", turnId: "turn-original" }
      });
      expect(provider.inputs[0]?.prompt).toContain("补充 Node 22 下的完整回归并报告退出码");
      expect(updated.status).toBe("in_progress");
      expect(listIssueRuns(db, issue.id)).toMatchObject([
        { attempt: 1, provider_session_id: "session-original", provider_turn_id: "turn-original" },
        { attempt: 2, provider_session_id: "session-original", provider_turn_id: "turn-next", status: "succeeded" }
      ]);
      expect(db.sqlite.query<{ count: number }, []>("select count(*) as count from issues").get()?.count).toBe(1);
    } finally {
      db.close();
    }
  });

  test("does not race past an open human review request", async () => {
    const db = await fixture();
    try {
      const issue = completedIssue(db, "Human owned");
      updateIssue(db, issue.id, { status: "needs_user" });
      createHumanReviewRequest(db, issue.id, { question: "请确认产品范围。" });
      updateIssue(db, issue.id, { status: "in_progress" });
      const card = await buildIssueCompletionCard(db, issue.id);

      await expect(applyPiAcceptanceDecision({ database: db }, card, decision("accept")))
        .rejects.toThrow("cannot bypass an open human review request");
      expect(getIssue(db, issue.id)?.status).toBe("in_progress");
    } finally {
      db.close();
    }
  });

  test("does not treat acceptance of a bounded product decision as terminal delivery acceptance", async () => {
    const db = await fixture();
    try {
      const issue = completedIssue(db, "Product decision only");
      const originCard = await buildIssueCompletionCard(db, issue.id);
      recordIssueCompletionCard(db, originCard, "test");
      updateIssue(db, issue.id, { status: "needs_user" });
      const request = createHumanReviewRequest(db, issue.id, {
        evidence_refs: [`completion-card:${originCard.fingerprint}`],
        kind: "decision",
        question: "是否选择方案 A？"
      });
      await reviewHumanIssue(db, issue.id, {
        action: "accept",
        comment: "选择方案 A。",
        review_request_id: request.id,
        review_revision: request.revision
      });
      const card = await buildIssueCompletionCard(db, issue.id);

      const updated = await applyPiAcceptanceDecision(
        { database: db },
        card,
        decision("needs_user", "还需要另一个独立产品决定。")
      );

      expect(updated.status).toBe("needs_user");
      expect(readIssueDecisionProjection(db, issue.id)).toMatchObject({
        owner: "human",
        request: { kind: "acceptance", revision: 2, status: "open" }
      });
      expect(db.sqlite.query<{ count: number }, [number]>(
        "select count(*) as count from issue_events where issue_id=? and type='issue.pi_human_acceptance_honored.v1'"
      ).get(issue.id)?.count).toBe(0);
    } finally {
      db.close();
    }
  });
});

class ContinuingProvider implements ExecutorProvider {
  readonly capabilities = ["issue_execution", "resume_session"] as const;
  readonly id = "codex" as const;
  readonly inputs: ProviderRecoveryInput[] = [];

  async run(_input: ProviderRunInput): Promise<ProviderRunResult> {
    throw new Error("run must not be used for PI continuation");
  }

  async recover(input: ProviderRecoveryInput): Promise<ProviderRunResult> {
    this.inputs.push(input);
    const session = { provider: this.id, sessionId: input.session.sessionId, turnId: "turn-next" };
    input.onEvent?.({
      provider: this.id,
      session,
      text: "补充验证通过。\nRUNNER_OUTCOME: completed",
      type: "text"
    });
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

class FreshSessionProvider implements ExecutorProvider {
  readonly capabilities = ["issue_execution", "resume_session"] as const;
  readonly id = "codex" as const;
  readonly inputs: ProviderRunInput[] = [];

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    this.inputs.push(input);
    const session = { provider: this.id, sessionId: "session-fresh", turnId: "turn-fresh" };
    input.onEvent?.({ provider: this.id, session, text: "完成剩余工作。\nRUNNER_OUTCOME: completed", type: "text" });
    input.onEvent?.({
      provider: this.id,
      raw: { method: "turn/completed", payload: JSON.stringify({ turn: { id: "turn-fresh", status: "completed" } }) },
      session,
      status: "completed",
      type: "done"
    });
    return { runId: "codex:session-fresh:turn-fresh", session };
  }
}

async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "pi-acceptance-application-"));
  roots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
     values ('demo', 'Demo', ?, 'codex', 1, ?, ?)`,
    [root, "2026-07-31T05:00:00Z", "2026-07-31T05:00:00Z"]
  );
  return db;
}

function completedIssue(
  db: RunnerDatabase,
  title: string,
  sessionID = "session-fixture",
  turnID = "turn-fixture"
) {
  const issue = createIssue(db, { project_id: "demo", status: "in_progress", title });
  const run = createIssueRun(db, issue.id);
  updateIssueRuntime(db, issue.id, {
    issue_run_id: run.id,
    provider: "codex",
    provider_session_id: sessionID,
    provider_turn_id: turnID
  });
  db.sqlite.run(
    "update issue_runs set status='succeeded', ended_at=? where id=?",
    [new Date(Date.now() + 1_000).toISOString(), run.id]
  );
  recordIssueEvent(db, issue.id, "issue.pi_acceptance_requested.v1", { issue_run_id: run.id });
  return getIssue(db, issue.id)!;
}

function decision(
  value: PiAcceptanceDecision["decision"],
  followUp?: string
): PiAcceptanceDecision {
  return {
    confidence: "high",
    decision: value,
    evidence_refs: ["run:fixture"],
    rationale: value === "accept" ? "当前事实满足 Issue。" : "需要在原 Session 补充明确工作。",
    unmet_requirements: value === "accept" ? [] : ["缺少一项明确验证"],
    ...(followUp ? { follow_up_prompt: followUp } : {})
  };
}
