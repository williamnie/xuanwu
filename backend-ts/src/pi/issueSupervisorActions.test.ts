import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { createIssueSupervisorEvent, listIssueSupervisorEvents, listPiActionEvents, listPiActions, upsertProjectPiPolicy } from "../db/repositories/pi.ts";
import { getPiRecoveryAttempt, listPiRecoveryAttempts, recordPiRecoveryAttempt } from "../db/repositories/pi/recoveryAttempts.ts";
import { EventBus, type AppEvent } from "../events/bus.ts";
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
      upsertProjectPiPolicy(db, {
        allowed_supervisor_actions_json: ["session.resume_followup"],
        project_id: "demo",
        supervisor_mode: "propose_only"
      });
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
      const [attempt] = listPiRecoveryAttempts(db, { issueId: 305 });
      expect(attempt).toMatchObject({
        action_type: "session.resume_followup",
        expected_provider_turn_id: "turn-old",
        progress_detected: 0,
        status: "executing"
      });
      expect(getPiRecoveryAttempt(db, `recovery-${result.executed_actions[0]}`)).toMatchObject({
        before_snapshot_json: expect.stringContaining('"issue":{"status":"in_progress"')
      });
      expect(listIssueSupervisorEvents(db, { issueId: 305 }).map((event) => event.event_type))
        .toEqual(["decision", "action", "result"]);
    } finally {
      db.close();
    }
  });

  test("publishes an autonomous needs-user escalation onto the shared EventBus", async () => {
    const db = await fixtureDb();
    const bus = new EventBus();
    const observed: AppEvent[] = [];
    const detach = bus.observe((event) => observed.push(event));
    try {
      insertProject(db, "demo");
      insertIssueRunSession(db, { issueID: 307, projectID: "demo", sessionID: "thread-307", turnID: "turn-old" });
      upsertProjectPiPolicy(db, {
        allowed_supervisor_actions_json: ["needs_user.escalate"],
        project_id: "demo",
        supervisor_mode: "autonomous"
      });

      const result = await applyIssueSupervisorDecisionActions({
        bus,
        context: buildIssueSupervisorRecoveryContext(db, 307, { now: NOW }),
        database: db,
        decision: needsUserDecision(),
        now: NOW
      });

      expect(result.executed_actions).toHaveLength(1);
      expect(observed).toContainEqual(expect.objectContaining({
        issueId: 307,
        projectId: "demo",
        type: "pi.needs_user"
      }));
      expect(listPiActions(db, { issueId: 307 })).toContainEqual(expect.objectContaining({
        action_type: "needs_user.escalate",
        status: "completed"
      }));
    } finally {
      detach();
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
      recordPiRecoveryAttempt(db, {
        action_type: "session.resume_followup",
        budget_window_started_at: "2026-06-09T08:00:00Z",
        created_at: "2026-06-10T07:55:00Z",
        diagnosis_code: "provider_timeout",
        id: "previous",
        idempotency_key: "previous",
        issue_id: 305,
        project_id: "demo",
        session_id: "codex:thread-305",
        status: "executing",
        updated_at: "2026-06-10T07:55:00Z"
      });

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

function needsUserDecision(): PiSupervisorDecisionJson {
  return {
    confidence: "high",
    decision: "needs_user",
    evidence_refs: ["verification_failure"],
    expected_outcome: "the user receives one actionable escalation",
    fallback_if_no_progress: "blocked",
    rationale: "A deterministic verification failure needs a user decision.",
    recovery_message: "Choose whether to retry from a fresh baseline.",
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
