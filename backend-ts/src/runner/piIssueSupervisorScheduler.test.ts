import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { listIssueSupervisorEvents, listPiActions, upsertProjectPiPolicy } from "../db/repositories/pi.ts";
import { listPiHeartbeatTimeline } from "../db/repositories/pi/heartbeatTimeline.ts";
import type { PiSupervisorDecisionJson } from "../pi/issueSupervisorRecovery.ts";
import type { ExecutorProvider, ProviderRunInput, SessionMessageInput } from "../providers/types.ts";
import { runPiIssueSupervisorSchedulerOnce } from "./piIssueSupervisorScheduler.ts";

const NOW = new Date("2026-06-10T08:00:00Z");
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
});

describe("PI issue supervisor scheduler", () => {
  test("default watchdog policy only records signal without creating approval spam", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo", await tempRoot("supervisor-watchdog-project-"));
      insertRunningIssue(db, {
        issueID: 498,
        projectID: "demo",
        sessionUpdatedAt: "2026-06-10T07:45:00Z",
        threadID: "thread-498",
        turnID: "turn-498"
      });
      insertIssueEvent(db, 498, { raw_payload: "stream disconnected before completion", type: "error" }, "2026-06-10T07:45:05Z");

      const result = await runPiIssueSupervisorSchedulerOnce({
        database: db,
        now: NOW,
        runDecision: async () => {
          throw new Error("watchdog must not call PI decision");
        },
        staleAfterSeconds: 300
      });

      expect(result).toMatchObject({ decisions: 0, failed: 0, scanned: 1, signaled: 1, skipped: 1 });
      expect(listPiActions(db, { issueId: 498 })).toEqual([]);
      expect(listIssueSupervisorEvents(db, { issueId: 498 }).map((event) => event.event_type))
        .toEqual(["signal"]);
    } finally {
      db.close();
    }
  });

  test("propose-only policy creates a manual pending follow-up without provider execution", async () => {
    const db = await fixtureDb();
    const provider = new SupervisorProvider();
    try {
      insertProject(db, "demo", await tempRoot("supervisor-propose-project-"));
      upsertProjectPiPolicy(db, { project_id: "demo", supervisor_mode: "propose_only" });
      insertRunningIssue(db, {
        issueID: 500,
        projectID: "demo",
        sessionUpdatedAt: "2026-06-10T07:45:00Z",
        threadID: "thread-500",
        turnID: "turn-500"
      });
      insertIssueEvent(db, 500, { raw_payload: "stream disconnected before completion", type: "error" }, "2026-06-10T07:45:05Z");

      const result = await runPiIssueSupervisorSchedulerOnce({
        database: db,
        now: NOW,
        providers: { codex: provider },
        runDecision: async () => ({ decision: resumeDecision(), raw_text: JSON.stringify(resumeDecision()), valid: true }),
        staleAfterSeconds: 300
      });

      expect(result).toMatchObject({ decisions: 1, failed: 0, scanned: 1, signaled: 1 });
      expect(provider.calls).toEqual([]);
      expect(listPiActions(db, { issueId: 500 })).toContainEqual(expect.objectContaining({
        action_type: "session.resume_followup",
        gate_decision: "ask",
        status: "pending"
      }));
      expect(listIssueSupervisorEvents(db, { issueId: 500 }).map((event) => event.event_type))
        .toEqual(["signal", "decision", "action"]);
    } finally {
      db.close();
    }
  });

  test("off supervisor mode skips analysis and actions", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo", await tempRoot("supervisor-off-project-"));
      upsertProjectPiPolicy(db, { project_id: "demo", supervisor_mode: "off" });
      insertRunningIssue(db, {
        issueID: 499,
        projectID: "demo",
        sessionUpdatedAt: "2026-06-10T07:45:00Z",
        threadID: "thread-499",
        turnID: "turn-499"
      });
      insertIssueEvent(db, 499, { raw_payload: "stream disconnected before completion", type: "error" }, "2026-06-10T07:45:05Z");

      const result = await runPiIssueSupervisorSchedulerOnce({ database: db, now: NOW, staleAfterSeconds: 300 });

      expect(result).toMatchObject({ decisions: 0, failed: 0, scanned: 1, signaled: 0 });
      expect(listIssueSupervisorEvents(db, { issueId: 499 })).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("runs PI decision after a stream disconnect becomes stale and records supervisor timeline", async () => {
    const db = await fixtureDb();
    const provider = new SupervisorProvider();
    try {
      insertProject(db, "demo", await tempRoot("supervisor-stream-project-"));
      upsertProjectPiPolicy(db, {
        allowed_supervisor_actions_json: ["session.resume_followup"],
        project_id: "demo",
        supervisor_mode: "autonomous"
      });
      insertRunningIssue(db, {
        issueID: 501,
        projectID: "demo",
        sessionUpdatedAt: "2026-06-10T07:50:00Z",
        threadID: "thread-501",
        turnID: "turn-old"
      });
      insertIssueEvent(db, 501, {
        provider: "codex",
        raw_payload: "Reconnecting... 1/5",
        type: "error"
      }, "2026-06-10T07:50:05Z");
      const result = await runPiIssueSupervisorSchedulerOnce({
        database: db,
        now: NOW,
        providers: { codex: provider },
        runDecision: async () => ({
          decision: resumeDecision(),
          raw_text: JSON.stringify(resumeDecision()),
          valid: true
        }),
        staleAfterSeconds: 300
      });

      expect(result).toMatchObject({ decisions: 1, failed: 0, scanned: 1, signaled: 1 });
      expect(provider.calls).toEqual([{ prompt: "Inspect current state and continue safely.", sessionId: "thread-501" }]);
      expect(listIssueSupervisorEvents(db, { issueId: 501 }).map((event) => event.event_type))
        .toEqual(["signal", "decision", "action", "result"]);
      expect(listPiActions(db, { issueId: 501 })).toContainEqual(expect.objectContaining({
        action_type: "session.resume_followup",
        gate_decision: "execute",
        status: "completed"
      }));
      expect(listIssueEvents(db, 501).map((event) => event.type)).toContain("issue.supervisor_resume_followup");
      expect(listPiHeartbeatTimeline(db, { issueId: 501 }).map((item) => item.event_type))
        .toEqual(expect.arrayContaining(["supervisor_signal", "supervisor_decision", "supervisor_action", "supervisor_result"]));
    } finally {
      db.close();
    }
  });

  test("due scheduled retry-after wakes PI decision even when an earlier wait action exists", async () => {
    const db = await fixtureDb();
    const calls: number[] = [];
    try {
      insertProject(db, "demo", await tempRoot("supervisor-due-retry-project-"));
      upsertProjectPiPolicy(db, { project_id: "demo", supervisor_mode: "propose_only" });
      insertRunningIssue(db, {
        issueID: 505,
        projectID: "demo",
        sessionUpdatedAt: "2026-06-10T07:55:00Z",
        threadID: "thread-505",
        turnID: "turn-505"
      });
      db.sqlite.run("update issues set auto_retry_next_at=?, auto_retry_reason=? where id=?",
        ["2026-06-10T08:10:00Z", "provider_retry_after_waiting", 505]);
      insertIssueEvent(db, 505, {
        action_id: "wait-action",
        reason: "provider_retry_after_waiting",
        retry_after_at: "2026-06-10T08:10:00Z"
      }, "2026-06-10T08:00:01Z", "issue.retry_after_scheduled");
      insertSupervisorActionEvents(db, 505, "2026-06-10T08:00:02Z");

      const result = await runPiIssueSupervisorSchedulerOnce({
        database: db,
        now: new Date("2026-06-10T08:10:00Z"),
        runDecision: async () => {
          calls.push(1);
          return { decision: waitDecision(), raw_text: JSON.stringify(waitDecision()), valid: true };
        },
        staleAfterSeconds: 300
      });

      expect(result).toMatchObject({ decisions: 1, failed: 0, signaled: 1 });
      expect(calls).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("does not create pending action when supervisor decision schema validation fails", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo", await tempRoot("supervisor-invalid-decision-project-"));
      upsertProjectPiPolicy(db, { project_id: "demo", supervisor_mode: "propose_only" });
      insertRunningIssue(db, {
        issueID: 510,
        projectID: "demo",
        sessionUpdatedAt: "2026-06-10T07:45:00Z",
        threadID: "thread-510",
        turnID: "turn-510"
      });
      insertIssueEvent(db, 510, { raw_payload: "stream disconnected before completion", type: "error" }, "2026-06-10T07:45:05Z");

      const result = await runPiIssueSupervisorSchedulerOnce({
        database: db,
        now: NOW,
        runDecision: async () => ({
          decision: noopDecision(),
          error: "supervisor decision failed schema validation",
          raw_text: "{}",
          valid: false
        }),
        staleAfterSeconds: 300
      });

      expect(result).toMatchObject({ decisions: 0, failed: 0, scanned: 1, signaled: 1, skipped: 1 });
      expect(listPiActions(db, { issueId: 510 })).toEqual([]);
      expect(listIssueSupervisorEvents(db, { issueId: 510 }).map((event) => event.event_type))
        .toEqual(["signal"]);
    } finally {
      db.close();
    }
  });

  test("autonomous allowlist dispatches issue retry through supervisor actions", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo", await tempRoot("supervisor-retry-now-project-"));
      upsertProjectPiPolicy(db, {
        allowed_supervisor_actions_json: ["issue.retry"],
        project_id: "demo",
        supervisor_mode: "autonomous"
      });
      insertRunningIssue(db, {
        issueID: 508,
        projectID: "demo",
        sessionUpdatedAt: "2026-06-10T07:45:00Z",
        threadID: "thread-508",
        turnID: "turn-508"
      });
      insertIssueEvent(db, 508, { raw_payload: "transient network error", type: "error" }, "2026-06-10T07:45:05Z");

      const result = await runPiIssueSupervisorSchedulerOnce({
        database: db,
        now: NOW,
        runDecision: async () => ({ decision: retryDecision(), raw_text: JSON.stringify(retryDecision()), valid: true }),
        staleAfterSeconds: 300
      });

      expect(result).toMatchObject({ decisions: 1, failed: 0, signaled: 1 });
      expect(getIssue(db, 508)).toMatchObject({ status: "todo", auto_retry_next_at: "" });
      expect(listPiActions(db, { issueId: 508 })).toContainEqual(expect.objectContaining({
        action_type: "issue.retry",
        gate_decision: "execute",
        status: "completed"
      }));
      expect(listIssueSupervisorEvents(db, { issueId: 508 }).map((event) => event.event_type))
        .toEqual(["signal", "decision", "action", "result"]);
    } finally {
      db.close();
    }
  });

  test("records no-progress result before considering a second stale resume", async () => {
    const db = await fixtureDb();
    const provider = new SupervisorProvider();
    try {
      insertProject(db, "demo", await tempRoot("supervisor-no-progress-project-"));
      upsertProjectPiPolicy(db, {
        allowed_supervisor_actions_json: ["session.resume_followup"],
        project_id: "demo",
        supervisor_cooldown_seconds: 1,
        supervisor_mode: "autonomous"
      });
      insertRunningIssue(db, {
        issueID: 509,
        projectID: "demo",
        sessionUpdatedAt: "2026-06-10T07:45:00Z",
        threadID: "thread-509",
        turnID: "turn-509"
      });
      insertIssueEvent(db, 509, { raw_payload: "stream disconnected before completion", type: "error" }, "2026-06-10T07:45:05Z");
      await runPiIssueSupervisorSchedulerOnce({
        database: db,
        now: NOW,
        providers: { codex: provider },
        runDecision: async () => ({ decision: resumeDecision(), raw_text: JSON.stringify(resumeDecision()), valid: true }),
        staleAfterSeconds: 300
      });
      db.sqlite.run("update issue_supervisor_events set created_at='2026-06-10T08:00:00Z' where issue_id=509 and event_type='action'");
      db.sqlite.run("update agent_sessions set updated_at='2026-06-10T08:00:01Z' where issue_id=509");

      const second = await runPiIssueSupervisorSchedulerOnce({
        database: db,
        now: new Date("2026-06-10T08:06:00Z"),
        runDecision: async () => ({ decision: noopDecision(), raw_text: JSON.stringify(noopDecision()), valid: true }),
        staleAfterSeconds: 300
      });
      const resultPayloads = listIssueSupervisorEvents(db, { issueId: 509 })
        .filter((event) => event.event_type === "result")
        .map((event) => JSON.parse(event.payload_json || "{}"));

      expect(second).toMatchObject({ decisions: 1, failed: 0, signaled: 1 });
      expect(resultPayloads).toContainEqual(expect.objectContaining({ outcome: "no_progress" }));
    } finally {
      db.close();
    }
  });

  test("waits for provider retry-after before running PI decision", async () => {
    const db = await fixtureDb();
    const calls: number[] = [];
    try {
      insertProject(db, "demo", await tempRoot("supervisor-retry-project-"));
      upsertProjectPiPolicy(db, { project_id: "demo", supervisor_mode: "propose_only" });
      insertRunningIssue(db, {
        issueID: 502,
        projectID: "demo",
        sessionUpdatedAt: "2026-06-10T07:55:00Z",
        threadID: "thread-502",
        turnID: "turn-502"
      });
      insertIssueEvent(db, 502, {
        provider: "codex",
        raw_payload: { error: "HTTP 429 too many requests", retry_after: 600, status_code: 429 },
        type: "error"
      }, "2026-06-10T08:00:00Z");

      const waiting = await runPiIssueSupervisorSchedulerOnce({
        database: db, now: new Date("2026-06-10T08:05:00Z"), staleAfterSeconds: 300,
        runDecision: async () => {
          calls.push(1);
          return { decision: waitDecision(), raw_text: JSON.stringify(waitDecision()), valid: true };
        }
      });
      const due = await runPiIssueSupervisorSchedulerOnce({
        database: db, now: new Date("2026-06-10T08:10:00Z"), staleAfterSeconds: 300,
        runDecision: async () => {
          calls.push(1);
          return { decision: waitDecision(), raw_text: JSON.stringify(waitDecision()), valid: true };
        }
      });

      expect(waiting).toMatchObject({ decisions: 0, signaled: 1 });
      expect(due).toMatchObject({ decisions: 1, signaled: 1 });
      expect(calls).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("does not mark a normally active executor session as stale", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo", await tempRoot("supervisor-active-project-"));
      insertRunningIssue(db, {
        issueID: 503,
        projectID: "demo",
        sessionUpdatedAt: "2026-06-10T07:59:30Z",
        threadID: "thread-503",
        turnID: "turn-503"
      });

      const result = await runPiIssueSupervisorSchedulerOnce({ database: db, now: NOW, staleAfterSeconds: 300 });

      expect(result).toMatchObject({ decisions: 0, scanned: 1, signaled: 0 });
      expect(listIssueSupervisorEvents(db, { issueId: 503 })).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("dedupes concurrent scheduler decisions for the same issue", async () => {
    const db = await fixtureDb();
    let release!: () => void; const started: number[] = [];
    try {
      insertProject(db, "demo", await tempRoot("supervisor-lock-project-"));
      upsertProjectPiPolicy(db, { project_id: "demo", supervisor_mode: "propose_only" });
      insertRunningIssue(db, {
        issueID: 504,
        projectID: "demo",
        sessionUpdatedAt: "2026-06-10T07:45:00Z",
        threadID: "thread-504",
        turnID: "turn-504"
      });
      insertIssueEvent(db, 504, { raw_payload: "stream disconnected before completion", type: "error" }, "2026-06-10T07:45:05Z");
      const runDecision = async () => {
        started.push(1);
        await new Promise<void>((resolve) => { release = resolve; });
        return { decision: waitDecision(), raw_text: JSON.stringify(waitDecision()), valid: true };
      };

      const first = runPiIssueSupervisorSchedulerOnce({ database: db, now: NOW, runDecision, staleAfterSeconds: 300 });
      await waitUntil(() => started.length === 1);
      const second = await runPiIssueSupervisorSchedulerOnce({ database: db, now: NOW, runDecision, staleAfterSeconds: 300 });
      release();

      expect(await first).toMatchObject({ decisions: 1 });
      expect(second.skipped).toBe(1);
      expect(started).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("falls back to an enabled global PI agent when project settings are absent", async () => {
    const db = await fixtureDb();
    const faux = registerFauxProvider({ api: "pi-supervisor-global-api", provider: "pi-supervisor-global" });
    try {
      faux.setResponses([fauxAssistantMessage(JSON.stringify(noopDecision()))]);
      insertProject(db, "demo", await tempRoot("supervisor-global-agent-project-"));
      upsertProjectPiPolicy(db, { project_id: "demo", supervisor_mode: "propose_only" });
      insertGlobalPiAgent(db, "pi-supervisor-global");
      writeFauxModelsConfig(db, "pi-supervisor-global");
      insertRunningIssue(db, {
        issueID: 506,
        projectID: "demo",
        sessionUpdatedAt: "2026-06-10T07:45:00Z",
        threadID: "thread-506",
        turnID: "turn-506"
      });

      const result = await runPiIssueSupervisorSchedulerOnce({ database: db, now: NOW, staleAfterSeconds: 300 });

      expect(result).toMatchObject({ decisions: 1, failed: 0, signaled: 1 });
      expect(faux.state.callCount).toBe(1);
      expect(listIssueSupervisorEvents(db, { issueId: 506 }).map((event) => event.event_type))
        .toEqual(["signal", "decision", "action"]);
    } finally {
      faux.unregister();
      db.close();
    }
  });

  test("dedupes missing supervisor agent failures during cooldown", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo", await tempRoot("supervisor-missing-agent-project-"));
      upsertProjectPiPolicy(db, { project_id: "demo", supervisor_mode: "propose_only" });
      insertRunningIssue(db, {
        issueID: 507,
        projectID: "demo",
        sessionUpdatedAt: "2026-06-10T07:45:00Z",
        threadID: "thread-507",
        turnID: "turn-507"
      });

      const first = await runPiIssueSupervisorSchedulerOnce({ database: db, now: NOW, staleAfterSeconds: 300 });
      const second = await runPiIssueSupervisorSchedulerOnce({ database: db, now: NOW, staleAfterSeconds: 300 });
      const events = listIssueSupervisorEvents(db, { issueId: 507 });

      expect(first).toMatchObject({ failed: 1, signaled: 1 });
      expect(second).toMatchObject({ failed: 0, skipped: 1 });
      expect(events.map((event) => event.event_type)).toEqual(["signal", "decision_failed"]);
      expect(events[1]?.payload_json).toContain("enable a global PI agent");
    } finally {
      db.close();
    }
  });
});

async function fixtureDb(): Promise<RunnerDatabase> {
  const root = await tempRoot("supervisor-scheduler-db-");
  return openDatabase({ stateDir: join(root, "state") });
}

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function insertProject(db: RunnerDatabase, projectID: string, cwd: string): void {
  mkdirSync(cwd, { recursive: true });
  db.sqlite.run(`insert into projects (id, name, cwd, provider, auto_run, sort_order, created_at, updated_at)
    values (?, ?, ?, 'codex', 1, 1, ?, ?)`, [projectID, projectID, cwd, "2026-06-10T07:00:00Z", "2026-06-10T07:00:00Z"]);
}

function insertRunningIssue(db: RunnerDatabase, input: {
  issueID: number; projectID: string; sessionUpdatedAt: string; threadID: string; turnID: string;
}): void {
  db.sqlite.run(`insert into issues (id, project_id, title, status, attempt_count, created_at, updated_at)
    values (?, ?, 'Supervisor issue', 'in_progress', 1, ?, ?)`,
  [input.issueID, input.projectID, "2026-06-10T07:00:00Z", input.sessionUpdatedAt]);
  db.sqlite.run(`insert into issue_runs
    (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id, started_at, ended_at)
    values (?, ?, 1, 'in_progress', 'codex', ?, ?, '2026-06-10T07:00:00Z', '')`,
  [`issue-${input.issueID}-attempt-1`, input.issueID, input.threadID, input.turnID]);
  db.sqlite.run(`insert into agent_sessions
    (session_key, provider, provider_session_id, project_id, issue_id, status, raw_ref, created_at, updated_at)
    values (?, 'codex', ?, ?, ?, 'running', ?, '2026-06-10T07:00:00Z', ?)`,
  [`codex:${input.threadID}`, input.threadID, input.projectID, input.issueID,
    JSON.stringify({ provider_turn_id: input.turnID }), input.sessionUpdatedAt]);
}

function insertIssueEvent(db: RunnerDatabase, issueID: number, payload: unknown, createdAt: string, type = "issue.log"): void {
  db.sqlite.run(`insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, type, JSON.stringify(payload), createdAt]);
}

function insertSupervisorActionEvents(db: RunnerDatabase, issueID: number, createdAt: string): void {
  for (const eventType of ["decision", "action", "result"]) {
    db.sqlite.run(`insert into issue_supervisor_events
      (issue_id, project_id, event_type, action_id, action_type, created_at)
      values (?, 'demo', ?, 'wait-action', 'issue.retry_after', ?)`,
    [issueID, eventType, createdAt]);
  }
}

function resumeDecision(): PiSupervisorDecisionJson {
  return {
    confidence: "high", decision: "resume_session", evidence_refs: ["provider_error"],
    expected_outcome: "session emits new progress", fallback_if_no_progress: "needs_user",
    rationale: "stream disconnected after stale threshold", recovery_message: "Inspect current state and continue safely.",
    risk_level: "medium"
  };
}

function waitDecision(): PiSupervisorDecisionJson {
  return {
    confidence: "medium", decision: "wait", evidence_refs: ["provider_error"],
    expected_outcome: "provider retry window is respected", fallback_if_no_progress: "needs_user",
    rationale: "wait for provider retry window", recovery_message: "", risk_level: "low",
    wait_until: "2026-06-10T08:10:00Z"
  };
}

function retryDecision(): PiSupervisorDecisionJson {
  return {
    confidence: "medium", decision: "retry_issue", evidence_refs: ["provider_error"],
    expected_outcome: "issue is queued for another run", fallback_if_no_progress: "needs_user",
    rationale: "retry after transient provider disconnect", recovery_message: "", risk_level: "medium"
  };
}

function noopDecision(): PiSupervisorDecisionJson {
  return {
    confidence: "medium", decision: "noop", evidence_refs: ["session"],
    expected_outcome: "supervisor records the fallback agent decision without recovery action",
    fallback_if_no_progress: "needs_user", rationale: "global fallback agent is runnable",
    recovery_message: "", risk_level: "low"
  };
}

function insertGlobalPiAgent(db: RunnerDatabase, provider: string): void {
  db.sqlite.run(`insert into pi_agents
    (id, name, provider, model_provider, model_id, thinking_level, cwd_policy, tools_json, instructions, enabled, created_at, updated_at)
    values (?, ?, 'pi-sdk', ?, 'faux-1', 'off', 'project', '[]', '', 1, ?, ?)`,
  ["pi-supervisor-global", "PI Supervisor Global", provider, "2026-06-10T07:00:00Z", "2026-06-10T07:00:00Z"]);
}

function writeFauxModelsConfig(db: RunnerDatabase, provider: string): void {
  const agentDir = join(db.path, "..", "pi-runtime", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: { [provider]: { api: `${provider}-api`, apiKey: "test", baseUrl: "http://localhost:0", models: [{ id: "faux-1" }] } }
  }));
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

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}
