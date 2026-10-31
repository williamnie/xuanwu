import { afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";

import { listIssueEvents, recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { createIssueRun } from "../db/repositories/issueRuns.ts";

import type { PiAcceptanceRuntimeResult } from "../pi/issues/issueAcceptance.ts";
import type { ExecutorProvider, ProviderRecoveryInput, ProviderRunInput, ProviderRunResult } from "../providers/types.ts";

import { useDatabaseCleanup } from "../testing/harness.ts";

export const trackDatabase = useDatabaseCleanup();

export const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

export class NextIssueProvider implements ExecutorProvider {
  readonly capabilities = ["issue_execution"] as const;
  readonly id = "codex" as const;
  readonly inputs: ProviderRunInput[] = [];

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    this.inputs.push(input);
    return {
      runId: `codex:next:${input.issueId}`,
      session: { provider: "codex", sessionId: `next-session-${input.issueId}`, turnId: `next-turn-${input.issueId}` }
    };
  }
}

export class CoordinatorContinuationProvider implements ExecutorProvider {
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

export class LatestTurnProvider implements ExecutorProvider {
  readonly capabilities = ["issue_execution", "sessions"] as const;
  readonly id = "codex" as const;

  async run(_input: ProviderRunInput): Promise<ProviderRunResult> {
    throw new Error("run must not be called");
  }

  async readSession(sessionId: string) {
    return {
      id: `codex:${sessionId}`,
      provider: "codex",
      provider_session_id: sessionId,
      updatedAt: 1_785_474_120,
      turns: [
        {
          id: "019fbb1a-134b-7da1-ba36-9725d960c543",
          items: [{ type: "agentMessage", text: "最初需要继续处理。" }],
          status: "completed"
        },
        {
          id: "019fbb3c-886f-74d0-a834-2d488e237a5d",
          items: [
            { type: "commandExecution", command: "/bin/zsh -lc 'custom-check --all; rc=$?; exit \"$rc\"'", exitCode: 0 },
            { type: "agentMessage", text: "实现和验证已经完成，工作区干净。" }
          ],
          status: "completed"
        }
      ]
    };
  }
}

export function acceptance(
  decision: "accept" | "needs_user",
  humanReviewKind?: "acceptance" | "decision" | "risk_acceptance"
): PiAcceptanceRuntimeResult {
  return {
    decision: {
      confidence: "high",
      decision,
      evidence_refs: ["run:fixture"],
      progress: { made_progress: true, evidence_refs: ["run:fixture"], summary: "当前 Run 有实质进展。" },
      rationale: decision === "accept" ? "当前 Run 的事实满足 Issue。" : "需要用户决定。",
      unmet_requirements: [],
      ...(humanReviewKind ? { human_review_kind: humanReviewKind } : {})
    },
    raw_text: "{}",
    valid: true
  };
}

export async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-pi-acceptance-"));
  roots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
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

export function completedIssue(db: RunnerDatabase, title: string) {
  const issue = createIssue(db, { project_id: "demo", status: "in_progress", title });
  const run = createIssueRun(db, issue.id);
  db.sqlite.run(
    "update issue_runs set status='succeeded', ended_at=? where id=?",
    ["2026-07-31T05:01:00Z", run.id]
  );
  recordIssueEvent(db, issue.id, "issue.pi_acceptance_requested.v1", { issue_run_id: run.id });
  return issue;
}

export function eventTypes(db: RunnerDatabase, issueID: number): string[] {
  return listIssueEvents(db, issueID).map((event) => event.type);
}

export async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition timed out");
}
