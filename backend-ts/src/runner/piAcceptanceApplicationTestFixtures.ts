import { afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createAgentProfile } from "../db/repositories/agentProfiles.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { createIssueRun, updateIssueRuntime } from "../db/repositories/issueRuns.ts";
import { getIssue } from "../db/repositories/issues.ts";

import type { PiAcceptanceDecision } from "../pi/issues/issueAcceptance.ts";

import type {
  ExecutorProvider,
  ProviderRecoveryInput,
  ProviderRunInput,
  ProviderRunResult
} from "../providers/types.ts";

import { useDatabaseCleanup } from "../testing/harness.ts";

export const trackDatabase = useDatabaseCleanup();

export const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

export class ContinuingProvider implements ExecutorProvider {
  readonly capabilities = ["issue_execution", "resume_session"] as const;
  readonly inputs: ProviderRecoveryInput[] = [];

  constructor(readonly id: "codex" | "claude" = "codex") {}

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

export class FreshSessionProvider implements ExecutorProvider {
  readonly capabilities = ["issue_execution", "resume_session"] as const;
  readonly inputs: ProviderRunInput[] = [];

  constructor(readonly id: "codex" | "claude" = "codex") {}

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

export async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "pi-acceptance-application-"));
  roots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
     values ('demo', 'Demo', ?, 'codex', 1, ?, ?)`,
    [root, "2026-07-31T05:00:00Z", "2026-07-31T05:00:00Z"]
  );
  return db;
}

export function completedIssue(
  db: RunnerDatabase,
  title: string,
  sessionID = "session-fixture",
  turnID = "turn-fixture",
  provider: "codex" | "claude" = "codex"
) {
  const issue = createIssue(db, { project_id: "demo", status: "in_progress", title });
  const run = createIssueRun(db, issue.id);
  updateIssueRuntime(db, issue.id, {
    issue_run_id: run.id,
    provider,
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

export function selectProviderDefaultProfile(db: RunnerDatabase, issueID: number, provider: "claude"): void {
  createAgentProfile(db, {
    id: `provider-default-${issueID}`,
    model: "",
    name: "Provider Default",
    provider
  });
  db.sqlite.run("update projects set model='codex-default' where id='demo'");
  db.sqlite.run("update issues set agent_profile_id=? where id=?", [`provider-default-${issueID}`, issueID]);
}

export function continuationStreaks(db: RunnerDatabase, issueID: number): number[] {
  return db.sqlite.query<{ payload: string }, [number]>(
    "select payload from issue_events where issue_id=? and type='issue.pi_continuation_progress.v1' order by id"
  ).all(issueID).map((row) => Number((JSON.parse(row.payload) as Record<string, unknown>).no_progress_streak));
}

export function decision(
  value: PiAcceptanceDecision["decision"],
  followUp?: string,
  humanReviewKind?: PiAcceptanceDecision["human_review_kind"],
  madeProgress = true
): PiAcceptanceDecision {
  return {
    confidence: "high",
    decision: value,
    evidence_refs: ["run:fixture"],
    progress: {
      evidence_refs: ["run:fixture"],
      made_progress: madeProgress,
      summary: madeProgress ? "当前 Run 有实质进展。" : "当前 Run 没有实质进展。"
    },
    rationale: value === "accept" ? "当前事实满足 Issue。" : "需要在原 Session 补充明确工作。",
    unmet_requirements: value === "accept" ? [] : ["缺少一项明确验证"],
    ...(humanReviewKind ? { human_review_kind: humanReviewKind } : {}),
    ...(followUp ? { follow_up_prompt: followUp } : {})
  };
}
