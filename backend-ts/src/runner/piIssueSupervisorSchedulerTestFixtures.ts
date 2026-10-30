import { afterEach } from "bun:test";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";

import type { PiSupervisorDecisionRuntimeResult } from "../pi/supervisor/issueSupervisorDecision.ts";
import type { PiSupervisorDecisionJson } from "../pi/supervisor/issueSupervisorRecovery.ts";
import type { ExecutorProvider, ProviderRunInput, SessionMessageInput } from "../providers/types.ts";

import { useDatabaseCleanup } from "../testing/harness.ts";

export const trackDatabase = useDatabaseCleanup();

export const NOW = new Date("2026-06-10T08:00:00Z");

export const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
});

export async function fixtureDb(): Promise<RunnerDatabase> {
  const root = await tempRoot("supervisor-scheduler-db-");
  return openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
}

export async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

export function insertProject(db: RunnerDatabase, projectID: string, cwd: string): void {
  mkdirSync(cwd, { recursive: true });
  db.sqlite.run(`insert into projects (id, name, cwd, provider, auto_run, sort_order, created_at, updated_at)
    values (?, ?, ?, 'codex', 1, 1, ?, ?)`, [
    projectID,
    projectID,
    cwd,
    "2026-06-10T07:00:00Z",
    "2026-06-10T07:00:00Z"
  ]);
  db.sqlite.run(`insert into project_pi_settings (project_id, created_at, updated_at) values (?, ?, ?)`, [
    projectID,
    "2026-06-10T07:00:00Z",
    "2026-06-10T07:00:00Z"
  ]);
}

export function insertRunningIssue(db: RunnerDatabase, input: {
  issueID: number;
  projectID: string;
  sessionUpdatedAt: string;
  threadID: string;
  turnID: string;
}): void {
  db.sqlite.run(`insert into issues (id, project_id, title, status, attempt_count, created_at, updated_at)
    values (?, ?, 'Supervisor issue', 'in_progress', 1, ?, ?)`, [
    input.issueID,
    input.projectID,
    "2026-06-10T07:00:00Z",
    input.sessionUpdatedAt
  ]);
  db.sqlite.run(`insert into issue_runs
    (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id, started_at, ended_at)
    values (?, ?, 1, 'in_progress', 'codex', ?, ?, '2026-06-10T07:00:00Z', '')`, [
    `issue-${input.issueID}-attempt-1`,
    input.issueID,
    input.threadID,
    input.turnID
  ]);
  db.sqlite.run(`insert into agent_sessions
    (session_key, provider, provider_session_id, project_id, issue_id, status, raw_ref, created_at, updated_at)
    values (?, 'codex', ?, ?, ?, 'running', ?, '2026-06-10T07:00:00Z', ?)`, [
    `codex:${input.threadID}`,
    input.threadID,
    input.projectID,
    input.issueID,
    JSON.stringify({ provider_turn_id: input.turnID }),
    input.sessionUpdatedAt
  ]);
}

export function insertIssueEvent(
  db: RunnerDatabase,
  issueID: number,
  payload: unknown,
  createdAt: string,
  type = "issue.log"
): void {
  db.sqlite.run(
    "insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)",
    [issueID, type, JSON.stringify(payload), createdAt]
  );
}

export function validDecision(decision: PiSupervisorDecisionJson): PiSupervisorDecisionRuntimeResult {
  return { decision, raw_text: JSON.stringify(decision), valid: true };
}

export function noopDecision(): PiSupervisorDecisionJson {
  return {
    confidence: "high",
    decision: "noop",
    evidence_refs: ["latest_run", "session"],
    expected_outcome: "no state changes before more evidence arrives",
    fallback_if_no_progress: "needs_user",
    rationale: "PI found no safe recovery action",
    recovery_message: "",
    risk_level: "low"
  };
}

export function resumeDecision(): PiSupervisorDecisionJson {
  return {
    confidence: "high",
    decision: "resume_session",
    evidence_refs: ["provider_error"],
    expected_outcome: "session emits new progress",
    fallback_if_no_progress: "needs_user",
    rationale: "stream disconnected after stale threshold",
    recovery_message: "Inspect current state and continue safely.",
    risk_level: "medium"
  };
}

export function stateRepairDecision(): PiSupervisorDecisionJson {
  return {
    confidence: "high",
    decision: "repair_issue_state",
    evidence_refs: ["issue", "latest_run", "session"],
    expected_outcome: "the ended provider session is reconciled and the executor slot is released",
    fallback_if_no_progress: "needs_user",
    rationale: "The provider Session completed while the Issue and Run remained open.",
    repair_diagnosis_code: "in_progress_session_ended",
    repair_operation: "request_pi_decision",
    risk_level: "medium"
  };
}

export function needsUserDecision(message: string): PiSupervisorDecisionJson {
  return {
    confidence: "low",
    decision: "needs_user",
    evidence_refs: ["supervisor_decision_invalid"],
    expected_outcome: "a human repairs PI before recovery",
    fallback_if_no_progress: "blocked",
    rationale: message,
    recovery_message: message,
    risk_level: "medium"
  };
}

export class SupervisorProvider implements ExecutorProvider {
  readonly calls: Record<string, unknown>[] = [];
  readonly capabilities = ["resume_session"] as const;
  readonly id = "codex" as const;

  async run(_input: ProviderRunInput): Promise<never> {
    throw new Error("not implemented");
  }

  async recover(input: Parameters<NonNullable<ExecutorProvider["recover"]>>[0]) {
    const result = await this.sendSessionMessage({ prompt: input.prompt, sessionId: input.session.sessionId });
    return { runId: `codex:${result.sessionId}:${result.turn_id}`,
      session: { provider: this.id, sessionId: result.sessionId, turnId: result.turn_id } };
  }

  async sendSessionMessage(input: SessionMessageInput) {
    this.calls.push({ prompt: input.prompt, sessionId: input.sessionId });
    return {
      provider: "codex" as const,
      provider_session_id: input.sessionId,
      sessionId: input.sessionId,
      turn_id: "turn-followup"
    };
  }
}
