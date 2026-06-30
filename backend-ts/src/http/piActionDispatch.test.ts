import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentSession } from "../db/repositories/agentSessions.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listNotifications } from "../db/repositories/notifications.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { createPiAction, getPiIssueCompletionWatch, listIssueSupervisorEvents } from "../db/repositories/pi.ts";
import { EventBus } from "../events/bus.ts";
import type { ExecutorProvider, ProviderRunInput, SessionMessageInput } from "../providers/types.ts";
import { dispatchPiAction } from "./piActionDispatch.ts";
import { isProjectLoopActive } from "../runner/projectLoopManager.ts";

const tempRoots: string[] = [];
const NO_AUTO_RUN_SETTLE_MS = 25;

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
});

describe("PI action dispatcher supervisor actions", () => {
  test("issue.enqueue starts only auto-run project loop after approval dispatch", async () => {
    const db = await fixtureDb();
    const provider = new SupervisorProvider();
    try {
      insertProject(db, "manual-demo", { autoRun: 0, provider: provider.id });
      insertProject(db, "auto-demo", { autoRun: 1, provider: provider.id });
      insertIssue(db, { issueID: 411, projectID: "manual-demo", status: "triage" });
      insertIssue(db, { issueID: 410, projectID: "auto-demo", status: "triage" });
      const manualAction = createPiAction(db, {
        action_type: "issue.enqueue",
        id: "enqueue-manual-action",
        issue_id: 411,
        payload_json: JSON.stringify({ issue_id: 411 }),
        project_id: "manual-demo",
        status: "approved"
      });
      const autoAction = createPiAction(db, {
        action_type: "issue.enqueue",
        id: "enqueue-auto-action",
        issue_id: 410,
        payload_json: JSON.stringify({ issue_id: 410 }),
        project_id: "auto-demo",
        status: "approved"
      });

      await dispatchPiAction({ database: db, providers: { codex: provider } }, manualAction);
      await Bun.sleep(NO_AUTO_RUN_SETTLE_MS);

      expect(provider.inputs).toEqual([]);
      expect(getIssue(db, 411)).toMatchObject({ status: "todo" });
      await dispatchPiAction({ database: db, providers: { codex: provider } }, autoAction);

      expect(provider.inputs[0]).toMatchObject({ issueId: 410, projectId: "auto-demo" });
      expect(getIssue(db, 410)).toMatchObject({ status: "in_progress" });
      await waitUntil(() => !isProjectLoopActive("auto-demo"));
    } finally {
      db.close();
    }
  });

  test("issue.enqueue can force kick the project loop for Runner Chat dispatch", async () => {
    const db = await fixtureDb();
    const provider = new SupervisorProvider();
    const kickedProjects: string[] = [];
    try {
      insertProject(db, "manual-demo", { autoRun: 0, provider: provider.id });
      insertIssue(db, { issueID: 386, projectID: "manual-demo", status: "triage" });
      const action = createPiAction(db, {
        action_type: "issue.enqueue",
        id: "enqueue-runner-chat-action",
        issue_id: 386,
        payload_json: JSON.stringify({ issue_id: 386 }),
        project_id: "manual-demo",
        source: "runner_chat",
        status: "approved"
      });

      await dispatchPiAction({
        database: db,
        providers: { codex: provider },
        startProjectLoop: (_runtime, projectID) => kickedProjects.push(projectID)
      }, action);

      expect(getIssue(db, 386)).toMatchObject({ status: "todo" });
      expect(kickedProjects).toEqual(["manual-demo"]);
      expect(provider.inputs).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("issue completion watch create/cancel dispatch persists watch rows after approval", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo");
      insertIssue(db, { issueID: 547, projectID: "demo", status: "todo" });
      const createAction = createPiAction(db, {
        action_type: "issue_completion_watch.create",
        id: "watch-create-action",
        payload_json: JSON.stringify({
          issue_ids: [547],
          project_id: "demo",
          source_event_id: "event-547",
          target_channel: "feishu",
          target_chat_id: "oc_group"
        }),
        project_id: "demo",
        status: "approved"
      });

      const created = await dispatchPiAction({ database: db }, createAction) as { watch_id?: string };
      const watchID = created.watch_id ?? "";

      expect(created).toMatchObject({
        already_satisfied: false,
        target_channel: "feishu",
        watched_issues: [expect.objectContaining({ id: 547, status: "todo" })]
      });
      expect(getPiIssueCompletionWatch(db, watchID)).toMatchObject({
        status: "active",
        target_chat_id: "oc_group",
        items: [expect.objectContaining({ issue_id: 547 })]
      });

      const cancelAction = createPiAction(db, {
        action_type: "issue_completion_watch.cancel",
        id: "watch-cancel-action",
        payload_json: JSON.stringify({ reason: "user_cancel", watch_id: watchID }),
        project_id: "demo",
        status: "approved"
      });
      const cancelled = await dispatchPiAction({ database: db }, cancelAction);

      expect(cancelled).toMatchObject({
        current_status: "cancelled",
        watch_id: watchID
      });
      expect(getPiIssueCompletionWatch(db, watchID)).toMatchObject({
        error: "user_cancel",
        status: "cancelled"
      });
    } finally {
      db.close();
    }
  });

  test("session.resume_followup sends a new session message and updates turn refs", async () => {
    const db = await fixtureDb();
    const provider = new SupervisorProvider();
    try {
      insertProject(db, "demo");
      insertIssueRunSession(db, { issueID: 305, projectID: "demo", sessionID: "thread-305", turnID: "turn-old" });
      const action = createPiAction(db, {
        action_type: "session.resume_followup",
        id: "resume-action",
        issue_id: 305,
        payload_json: JSON.stringify({
          expected_issue_updated_at: "2026-06-10T07:00:00Z",
          expected_provider_turn_id: "turn-old",
          expected_run_id: "issue-305-attempt-1",
          expected_session_updated_at: "2026-06-10T07:01:00Z",
          issue_id: 305,
          prompt: "Inspect current state and continue safely.",
          provider: "codex",
          provider_session_id: "thread-305"
        }),
        project_id: "demo",
        status: "approved"
      });

      await dispatchPiAction({ database: db, providers: { codex: provider } }, action);

      expect(provider.calls).toEqual([{ prompt: "Inspect current state and continue safely.", sessionId: "thread-305" }]);
      expect(JSON.parse(getAgentSession(db, "codex:thread-305")?.raw_ref ?? "{}")).toMatchObject({
        provider_turn_id: "turn-followup"
      });
      expect(listIssueRuns(db, 305).at(-1)).toMatchObject({ provider_turn_id: "turn-followup" });
      expect(listIssueEvents(db, 305).map((event) => event.type)).toContain("issue.supervisor_resume_followup");
    } finally {
      db.close();
    }
  });

  test("issue.retry_after records due time without resuming the provider", async () => {
    const db = await fixtureDb();
    const provider = new SupervisorProvider();
    try {
      insertProject(db, "demo");
      insertIssueRunSession(db, { issueID: 306, projectID: "demo", sessionID: "thread-306", turnID: "turn-old" });
      const action = createPiAction(db, {
        action_type: "issue.retry_after",
        id: "retry-after-action",
        issue_id: 306,
        payload_json: JSON.stringify({
          issue_id: 306,
          reason: "provider_rate_limited",
          expected_issue_updated_at: "2026-06-10T07:00:00Z",
          expected_run_id: "issue-306-attempt-1",
          retry_after_at: "2026-06-10T08:10:00Z",
          source_event_id: 7
        }),
        project_id: "demo",
        status: "approved"
      });

      await dispatchPiAction({ database: db, providers: { codex: provider } }, action);

      expect(provider.calls).toEqual([]);
      expect(getIssue(db, 306)).toMatchObject({
        auto_retry_next_at: "2026-06-10T08:10:00Z",
        auto_retry_reason: "provider_rate_limited",
        status: "in_progress"
      });
      expect(listIssueEvents(db, 306).map((event) => event.type)).toContain("issue.retry_after_scheduled");
    } finally {
      db.close();
    }
  });

  test("issue.retry queues a stale issue and records supervisor result", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo");
      insertIssueRunSession(db, { issueID: 309, projectID: "demo", sessionID: "thread-309", turnID: "turn-old" });
      const action = createPiAction(db, {
        action_type: "issue.retry",
        id: "retry-action",
        issue_id: 309,
        payload_json: JSON.stringify({
          diagnosis_code: "provider_transient_network_error",
          expected_issue_updated_at: "2026-06-10T07:00:00Z",
          expected_run_id: "issue-309-attempt-1",
          issue_id: 309,
          reason: "transient provider disconnect"
        }),
        project_id: "demo",
        status: "approved"
      });

      await dispatchPiAction({ database: db }, action);

      expect(getIssue(db, 309)).toMatchObject({ status: "todo", auto_retry_next_at: "" });
      expect(listIssueRuns(db, 309).at(-1)).toMatchObject({ ended_at: expect.stringMatching(/Z$/), status: "todo" });
      expect(listIssueEvents(db, 309).map((event) => event.type)).toEqual(expect.arrayContaining([
        "issue.status_changed",
        "issue.supervisor_retry"
      ]));
      expect(listIssueSupervisorEvents(db, { issueId: 309 })).toContainEqual(expect.objectContaining({
        action_id: "retry-action",
        action_type: "issue.retry",
        event_type: "result"
      }));
    } finally {
      db.close();
    }
  });

  test("issue.supervisor_decision records PI judgement only", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo");
      insertIssueRunSession(db, { issueID: 307, projectID: "demo", sessionID: "thread-307", turnID: "turn-old" });
      const beforeRun = listIssueRuns(db, 307).at(-1);
      const action = createPiAction(db, {
        action_type: "issue.supervisor_decision",
        id: "decision-action",
        issue_id: 307,
        payload_json: JSON.stringify({
          decision: { decision: "noop", rationale: "observe" },
          expected_issue_updated_at: "2026-06-10T07:00:00Z",
          expected_run_id: "issue-307-attempt-1",
          issue_id: 307
        }),
        project_id: "demo",
        status: "approved"
      });

      await dispatchPiAction({ database: db }, action);

      expect(getIssue(db, 307)).toMatchObject({ status: "in_progress", auto_retry_next_at: "" });
      expect(listIssueRuns(db, 307).at(-1)).toEqual(beforeRun);
      expect(listIssueEvents(db, 307).map((event) => event.type)).toEqual(["issue.supervisor_decision"]);
    } finally {
      db.close();
    }
  });

  test("needs_user.escalate writes a redacted comment notification and app event once", async () => {
    const db = await fixtureDb();
    const bus = new EventBus();
    const events: unknown[] = [];
    const stop = bus.observe((event) => events.push(event));
    try {
      insertProject(db, "demo");
      insertIssueRunSession(db, { issueID: 421, projectID: "demo", sessionID: "thread-421", turnID: "turn-421" });
      const action = createPiAction(db, {
        action_type: "needs_user.escalate",
        id: "needs-user-action",
        issue_id: 421,
        payload_json: JSON.stringify({
          diagnosis_code: "provider_auth_failed",
          issue_id: 421,
          message: "Codex auth failed TOKEN=secret-value\n    at leak (/Users/xiaobei/private/app.ts:1)",
          next_step: "Refresh provider credentials and retry issue #421.",
          provider: "codex"
        }),
        project_id: "demo",
        status: "approved"
      });

      await dispatchPiAction({ bus, database: db }, action);
      await dispatchPiAction({ bus, database: db }, action);

      const comments = listIssueEvents(db, 421).filter((item) => item.type === "issue.comment");
      const notifications = listNotifications(db, { projectID: "demo", unreadOnly: true });
      const text = JSON.stringify({ comments, events, notifications });
      expect(comments).toHaveLength(1);
      expect(JSON.parse(comments[0]?.payload ?? "{}")).toMatchObject({
        author: "agent",
        body: expect.stringContaining("Provider：codex")
      });
      expect(notifications).toMatchObject([
        expect.objectContaining({ event: "pi.needs_user", issue_id: 421, read_at: "" })
      ]);
      expect(getIssue(db, 421)).toMatchObject({ status: "failed" });
      expect(listIssueRuns(db, 421).at(-1)).toMatchObject({
        ended_at: expect.stringMatching(/Z$/),
        exit_reason: "failed",
        status: "failed"
      });
      expect(events).toMatchObject([
        expect.objectContaining({ type: "pi.needs_user", issueId: 421, projectId: "demo" })
      ]);
      expect(text).toContain("provider_auth_failed");
      expect(text).toContain("Refresh provider credentials");
      expect(text).not.toContain("secret-value");
      expect(text).not.toContain("/Users/xiaobei");
      expect(text).not.toContain("at leak");
    } finally {
      stop();
      db.close();
    }
  });

  test("guardian needs_user skips stale issue preconditions without notifying", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo");
      insertIssueRunSession(db, { issueID: 422, projectID: "demo", sessionID: "thread-422", turnID: "turn-422" });
      const action = createPiAction(db, {
        action_type: "needs_user.escalate",
        id: "needs-user-stale-action",
        issue_id: 422,
        payload_json: JSON.stringify({
          diagnosis_code: "requires_human_decision",
          expected_issue_updated_at: "2026-06-10T06:59:00Z",
          issue_id: 422,
          message: "stale escalation",
          provider: "codex"
        }),
        project_id: "demo",
        source: "pi_guardian_orchestrator",
        status: "approved"
      });

      await expect(dispatchPiAction({ database: db }, action)).resolves.toMatchObject({
        reason: "issue_changed",
        skipped: true
      });

      expect(listNotifications(db, { projectID: "demo", unreadOnly: true })).toEqual([]);
      expect(listIssueEvents(db, 422).filter((item) => item.type === "issue.comment")).toEqual([]);
      expect(getIssue(db, 422)).toMatchObject({ status: "in_progress" });
    } finally {
      db.close();
    }
  });

  test("guardian needs_user waits while the executor session is still active", async () => {
    const db = await fixtureDb();
    try {
      insertProject(db, "demo");
      insertIssueRunSession(db, { issueID: 423, projectID: "demo", sessionID: "thread-423", turnID: "turn-423" });
      const now = new Date().toISOString();
      db.sqlite.run("update agent_sessions set updated_at=? where session_key=?", [now, "codex:thread-423"]);
      const action = createPiAction(db, {
        action_type: "needs_user.escalate",
        id: "needs-user-active-session-action",
        issue_id: 423,
        payload_json: JSON.stringify({
          diagnosis_code: "requires_human_decision",
          expected_issue_status: "in_progress",
          expected_issue_updated_at: "2026-06-10T07:00:00Z",
          expected_provider_session_id: "thread-423",
          expected_provider_turn_id: "turn-423",
          expected_run_id: "issue-423-attempt-1",
          expected_run_status: "in_progress",
          expected_session_status: "running",
          expected_session_turn_id: "turn-423",
          expected_session_updated_at: now,
          issue_id: 423,
          message: "active session escalation",
          provider: "codex"
        }),
        project_id: "demo",
        source: "pi_guardian_orchestrator",
        status: "approved"
      });

      await expect(dispatchPiAction({ database: db }, action)).resolves.toMatchObject({
        reason: "recent_session_activity",
        skipped: true
      });
      expect(listNotifications(db, { projectID: "demo", unreadOnly: true })).toEqual([]);
      expect(listIssueEvents(db, 423).filter((item) => item.type === "issue.comment")).toEqual([]);
      expect(getIssue(db, 423)).toMatchObject({ status: "in_progress" });
    } finally {
      db.close();
    }
  });

  test("resume follow-up refuses stale issue/run/session preconditions", async () => {
    const db = await fixtureDb();
    const provider = new SupervisorProvider();
    try {
      insertProject(db, "demo");
      insertIssueRunSession(db, { issueID: 308, projectID: "demo", sessionID: "thread-308", turnID: "turn-old" });
      const action = createPiAction(db, {
        action_type: "session.resume_followup",
        id: "stale-resume-action",
        issue_id: 308,
        payload_json: JSON.stringify({
          expected_issue_updated_at: "2026-06-10T06:59:00Z",
          expected_provider_turn_id: "turn-old",
          expected_run_id: "issue-308-attempt-1",
          expected_session_updated_at: "2026-06-10T07:01:00Z",
          issue_id: 308,
          prompt: "continue",
          provider: "codex",
          provider_session_id: "thread-308"
        }),
        project_id: "demo",
        status: "approved"
      });

      await expect(dispatchPiAction({ database: db, providers: { codex: provider } }, action))
        .rejects.toThrow("issue changed before PI action execution");
      expect(provider.calls).toEqual([]);
    } finally {
      db.close();
    }
  });
});

async function fixtureDb(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-dispatch-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(
  db: RunnerDatabase,
  id: string,
  options: { autoRun?: number; provider?: string } = {}
): void {
  db.sqlite.run(`insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?)`, [id, id, `/tmp/${id}`, options.provider ?? "codex",
      options.autoRun ?? 0, "2026-06-10T06:00:00Z", "2026-06-10T06:00:00Z"]);
}

function insertIssue(db: RunnerDatabase, input: { issueID: number; projectID: string; status: string }): void {
  db.sqlite.run(`insert into issues (id, project_id, title, status, created_at, updated_at)
    values (?, ?, 'Queue me', ?, ?, ?)`,
  [input.issueID, input.projectID, input.status, "2026-06-10T06:00:00Z", "2026-06-10T06:00:00Z"]);
}

function insertIssueRunSession(db: RunnerDatabase, input: {
  issueID: number;
  projectID: string;
  sessionID: string;
  turnID: string;
}): void {
  db.sqlite.run(`insert into issues (id, project_id, title, status, created_at, updated_at)
    values (?, ?, 'Supervisor issue', 'in_progress', ?, ?)`,
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

class SupervisorProvider implements ExecutorProvider {
  readonly calls: Record<string, unknown>[] = [];
  readonly capabilities = ["issue_execution", "resume_session"] as const;
  readonly id = "codex" as const;
  readonly inputs: ProviderRunInput[] = [];

  async run(input: ProviderRunInput) {
    this.inputs.push(input);
    return {
      runId: `codex-run-${input.issueId}`,
      session: { provider: this.id, sessionId: `codex-session-${input.issueId}`, turnId: `codex-turn-${input.issueId}` }
    };
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
  for (let index = 0; index < 30; index += 1) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition timed out");
}
