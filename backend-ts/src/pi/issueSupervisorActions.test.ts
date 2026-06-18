import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { createIssueSupervisorEvent, listIssueSupervisorEvents, listPiActionEvents, listPiActions, upsertProjectPiPolicy } from "../db/repositories/pi.ts";
import { recordPiRecoveryAttempt } from "../db/repositories/pi/recoveryAttempts.ts";
import type { ExecutorProvider, ProviderRunInput, SessionMessageInput } from "../providers/types.ts";
import { buildIssueSupervisorRecoveryContext } from "./issueSupervisorContext.ts";
import { applyIssueSupervisorDecisionActions } from "./issueSupervisorActions.ts";
import type { PiSupervisorDecisionJson } from "./issueSupervisorRecovery.ts";

const NOW = new Date("2026-06-10T08:00:00Z");
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
});

describe("PI issue supervisor actions", () => {
  test("propose_only creates gated proposal and does not execute resume follow-up", async () => {
    const db = await fixtureDb();
    const provider = new SupervisorProvider();
    try {
      insertProject(db, "demo");
      insertIssueRunSession(db, { issueID: 305, projectID: "demo", sessionID: "thread-305", turnID: "turn-old" });

      const result = await applyIssueSupervisorDecisionActions({
        context: buildIssueSupervisorRecoveryContext(db, 305, { now: NOW }),
        database: db,
        decision: resumeDecision(),
        now: NOW,
        providers: { codex: provider }
      });

      expect(result.executed_actions).toEqual([]);
      expect(provider.calls).toEqual([]);
      expect(result.actions).toContainEqual(expect.objectContaining({
        action_type: "session.resume_followup",
        decision: "ask",
        status: "pending"
      }));
      expect(listPiActionEvents(db, { actionId: result.actions[0]?.action_id }).map((event) => event.event_type))
        .toEqual(["candidate", "gate_decision", "pending_approval"]);
      expect(listIssueSupervisorEvents(db, { issueId: 305 }).map((event) => event.event_type))
        .toEqual(["decision", "action"]);
    } finally {
      db.close();
    }
  });

  test("autonomous policy executes covered resume follow-up and writes audit trails", async () => {
    const db = await fixtureDb();
    const provider = new SupervisorProvider();
    try {
      insertProject(db, "demo");
      insertIssueRunSession(db, { issueID: 305, projectID: "demo", sessionID: "thread-305", turnID: "turn-old" });
      upsertProjectPiPolicy(db, {
        allowed_supervisor_actions_json: ["session.resume_followup"],
        project_id: "demo",
        supervisor_mode: "autonomous"
      });

      const result = await applyIssueSupervisorDecisionActions({
        context: buildIssueSupervisorRecoveryContext(db, 305, { now: NOW }),
        database: db,
        decision: resumeDecision(),
        now: NOW,
        providers: { codex: provider }
      });

      expect(provider.calls).toEqual([{ prompt: "Inspect state and continue safely.", sessionId: "thread-305" }]);
      expect(result.executed_actions).toHaveLength(1);
      expect(listPiActions(db, { issueId: 305 })).toContainEqual(expect.objectContaining({
        action_type: "session.resume_followup",
        gate_decision: "execute",
        status: "completed"
      }));
      expect(listIssueEvents(db, 305).map((event) => event.type)).toContain("issue.supervisor_resume_followup");
      expect(listIssueSupervisorEvents(db, { issueId: 305 }).map((event) => event.event_type))
        .toEqual(["decision", "action", "result"]);
    } finally {
      db.close();
    }
  });

  test("cooldown and budget stop autonomous recovery before provider execution", async () => {
    const db = await fixtureDb();
    const provider = new SupervisorProvider();
    try {
      insertProject(db, "demo");
      insertIssueRunSession(db, { issueID: 305, projectID: "demo", sessionID: "thread-305", turnID: "turn-old" });
      upsertProjectPiPolicy(db, {
        allowed_supervisor_actions_json: ["session.resume_followup"],
        project_id: "demo",
        supervisor_cooldown_seconds: 600,
        supervisor_mode: "autonomous"
      });
      createIssueSupervisorEvent(db, {
        action_id: "previous",
        action_type: "session.resume_followup",
        event_type: "action",
        issue_id: 305,
        project_id: "demo"
      });
      db.sqlite.run("update issue_supervisor_events set created_at='2026-06-10T07:55:00Z' where action_id='previous'");

      const result = await applyIssueSupervisorDecisionActions({
        context: buildIssueSupervisorRecoveryContext(db, 305, { now: NOW }),
        database: db,
        decision: resumeDecision(),
        now: NOW,
        providers: { codex: provider }
      });

      expect(provider.calls).toEqual([]);
      expect(result.actions).toContainEqual(expect.objectContaining({
        action_type: "session.resume_followup",
        decision: "snooze",
        status: "snoozed"
      }));
      expect(listPiActions(db, { issueId: 305 })).toContainEqual(expect.objectContaining({ gate_decision: "snooze" }));
    } finally {
      db.close();
    }
  });

  test("recovery budget and cooldown survive context rebuild after database reopen", async () => {
    const { db, root } = await fixtureDbWithRoot();
    const provider = new SupervisorProvider();
    try {
      insertProject(db, "demo");
      insertIssueRunSession(db, { issueID: 306, projectID: "demo", sessionID: "thread-306", turnID: "turn-old" });
      upsertProjectPiPolicy(db, {
        allowed_supervisor_actions_json: ["session.resume_followup"],
        project_id: "demo",
        supervisor_cooldown_seconds: 600,
        supervisor_max_recoveries_per_issue: 1,
        supervisor_mode: "autonomous"
      });
      for (const index of [1, 2, 3]) {
        recordPiRecoveryAttempt(db, {
          action_type: "issue.retry",
          budget_window_started_at: "2026-06-10T00:00:00Z",
          created_at: `2026-06-10T07:5${index}:00Z`,
          diagnosis_code: "provider_timeout",
          id: `previous-${index}`,
          idempotency_key: `previous-${index}`,
          issue_id: 306,
          project_id: "demo",
          session_id: "codex:thread-306",
          status: "executing",
          updated_at: `2026-06-10T07:5${index}:00Z`
        });
      }
      db.close();

      const reopened = await openDatabase({ stateDir: join(root, "state") });
      try {
        const result = await applyIssueSupervisorDecisionActions({
          context: buildIssueSupervisorRecoveryContext(reopened, 306, { now: NOW }),
          database: reopened,
          decision: resumeDecision(),
          now: NOW,
          providers: { codex: provider }
        });

        expect(provider.calls).toEqual([]);
        expect(result.actions).toContainEqual(expect.objectContaining({
          action_type: "session.resume_followup",
          decision: "deny",
          status: "denied"
        }));
        expect(listPiActions(reopened, { issueId: 306 })).toContainEqual(expect.objectContaining({
          gate_decision: "deny",
          gate_reason: expect.stringContaining("budget")
        }));
      } finally {
        reopened.close();
      }
    } finally {
      try { db.close(); } catch {}
    }
  });
});

async function fixtureDb(): Promise<RunnerDatabase> {
  return (await fixtureDbWithRoot()).db;
}

async function fixtureDbWithRoot(): Promise<{ db: RunnerDatabase; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-supervisor-actions-"));
  tempRoots.push(root);
  return { db: await openDatabase({ stateDir: join(root, "state") }), root };
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(`insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
    values (?, ?, ?, 'codex', 1, ?, ?)`, [id, id, `/tmp/${id}`, "2026-06-10T06:00:00Z", "2026-06-10T06:00:00Z"]);
}

function insertIssueRunSession(db: RunnerDatabase, input: {
  issueID: number;
  projectID: string;
  sessionID: string;
  turnID: string;
}): void {
  db.sqlite.run(`insert into issues (id, project_id, title, status, attempt_count, created_at, updated_at)
    values (?, ?, 'Supervisor issue', 'in_progress', 1, ?, ?)`,
  [input.issueID, input.projectID, "2026-06-10T06:00:00Z", "2026-06-10T07:00:00Z"]);
  db.sqlite.run(`insert into issue_runs
    (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id, started_at, ended_at)
    values (?, ?, 1, 'in_progress', 'codex', ?, ?, ?, '')`,
  [`issue-${input.issueID}-attempt-1`, input.issueID, input.sessionID, input.turnID, "2026-06-10T06:30:00Z"]);
  db.sqlite.run(`insert into agent_sessions
    (session_key, provider, provider_session_id, project_id, issue_id, status, raw_ref, created_at, updated_at)
    values (?, 'codex', ?, ?, ?, 'running', ?, ?, ?)`,
  [`codex:${input.sessionID}`, input.sessionID, input.projectID, input.issueID,
    JSON.stringify({ provider_turn_id: input.turnID }), "2026-06-10T06:30:00Z", "2026-06-10T07:01:00Z"]);
}

function resumeDecision(): PiSupervisorDecisionJson {
  return {
    confidence: "high",
    decision: "resume_session",
    evidence_refs: ["provider_error"],
    expected_outcome: "session emits new progress",
    fallback_if_no_progress: "needs_user",
    rationale: "stream disconnected",
    recovery_message: "Inspect state and continue safely.",
    risk_level: "medium"
  };
}

class SupervisorProvider implements ExecutorProvider {
  readonly calls: Record<string, unknown>[] = [];
  readonly capabilities = ["resume_session"] as const;
  readonly id = "codex" as const;

  async run(_input: ProviderRunInput): Promise<never> {
    throw new Error("not implemented");
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
