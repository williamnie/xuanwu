import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getIssue, listIssues } from "../db/repositories/issues.ts";
import { createPiAction, getPiAction, listPiActions, updatePiAction } from "../db/repositories/pi.ts";
import { getProject, type Project } from "../db/repositories/projects.ts";
import { EventBus } from "../events/bus.ts";
import type { ExecutorProvider, ProviderRunInput, SessionMessageInput } from "../providers/types.ts";
import { createPiRunnerActions } from "../pi/runnerActions.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-actions-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun PI actions API", () => {
  test("lists pending actions and publishes PI action SSE events", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const project = mustGetProject(database, "demo");
      const issueID = insertIssue(database, project.id);
      const bus = new EventBus();
      const router = createDefaultRouter({ bus, database });
      const stream = await router.handle(new Request(`${BASE_URL}/api/events`));
      const reader = stream.body?.getReader();
      await reader?.read();

      const action = createPiRunnerActions(database, {
        bus,
        conversationID: "conv-1",
        project
      }).enqueueIssueProposal({ issue_id: issueID, rationale: "ready" }) as { action_id: string };

      const response = await router.handle(new Request(`${BASE_URL}/api/pi/actions?project_id=demo&status=pending`));

      expect(response.status).toBe(200);
      expect((await response.json() as Array<Record<string, unknown>>).map((item) => item.id)).toEqual([action.action_id]);
      expect(listPiActions(database, { status: "pending" })).toHaveLength(1);
      const event = await reader?.read();
      await reader?.cancel();
      const text = new TextDecoder().decode(event?.value);
      expect(text).toContain('"type":"pi.action_pending"');
      expect(text).toContain(`\\"action_id\\":\\"${action.action_id}\\"`);
      expect(text).toContain('\\"risk_level\\":\\"medium\\"');
    } finally {
      database.close();
    }
  });

  test("approve executes a pending action once and is idempotent", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const project = mustGetProject(database, "demo");
      const issueID = insertIssue(database, project.id);
      const action = createPiRunnerActions(database, { project })
        .enqueueIssueProposal({ issue_id: issueID, rationale: "ready" }) as { action_id: string };
      const bus = new EventBus();
      const events = bus.subscribe();
      const router = createDefaultRouter({ bus, database });

      const first = await postAction(router, action.action_id, "approve");
      const second = await postAction(router, action.action_id, "approve");

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await first.json()).toMatchObject({ id: action.action_id, status: "completed" });
      expect(await second.json()).toMatchObject({ id: action.action_id, status: "completed" });
      expect(getIssue(database, issueID)).toMatchObject({ status: "todo" });
      expect(listEvents(database).map((event) => event.type)).toEqual(["issue.status_changed"]);
      expect((await events.next())?.type).toBe("pi.action_approved");
      expect((await events.next())?.type).toBe("pi.action_executing");
      expect((await events.next())?.type).toBe("pi.action_completed");
      events.close();
    } finally {
      database.close();
    }
  });

  test("reject does not execute the pending payload", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const project = mustGetProject(database, "demo");
      const issueID = insertIssue(database, project.id);
      const action = createPiRunnerActions(database, { project })
        .enqueueIssueProposal({ issue_id: issueID, rationale: "not yet" }) as { action_id: string };

      const response = await postAction(createDefaultRouter({ database }), action.action_id, "reject");

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: action.action_id, status: "rejected" });
      expect(getIssue(database, issueID)).toMatchObject({ status: "triage" });
      expect(listEvents(database)).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("execute runs approved actions and records failed results", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const project = mustGetProject(database, "demo");
      const issueID = insertIssue(database, project.id);
      const action = createPiRunnerActions(database, { project })
        .enqueueIssueProposal({ issue_id: issueID }) as { action_id: string };
      updatePiAction(database, action.action_id, { status: "approved" });
      createPiAction(database, {
        id: "bad-action",
        action_type: "issue.enqueue", gate_decision: "ask",
        status: "approved",
        payload_json: JSON.stringify({ issue_id: 9999 })
      });
      const router = createDefaultRouter({ database });

      const completed = await postAction(router, action.action_id, "execute");
      const failed = await postAction(router, "bad-action", "execute");

      expect(completed.status).toBe(200);
      expect(await completed.json()).toMatchObject({ id: action.action_id, status: "completed" });
      expect(getIssue(database, issueID)).toMatchObject({ status: "todo" });
      expect(failed.status).toBe(200);
      expect(await failed.json()).toMatchObject({ id: "bad-action", status: "failed" });
      expect(getPiAction(database, "bad-action")?.result_json).toContain("资源不存在");
    } finally {
      database.close();
    }
  });

  test("approve executes issue state repair proposals through dispatcher", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const project = mustGetProject(database, "demo");
      const issueID = insertIssue(database, project.id, { error: "network error", status: "failed" });
      const action = createPiRunnerActions(database, { project })
        .createIssueStateRepairProposal({ issue_id: issueID }) as { action_id: string };

      const response = await postAction(createDefaultRouter({ database }), action.action_id, "approve");

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: action.action_id, status: "completed" });
      expect(getIssue(database, issueID)).toMatchObject({ status: "todo", error: "" });
      expect(listEvents(database).map((event) => event.type)).toEqual([
        "issue.status_changed",
        "issue.state_manager_repair"
      ]);
    } finally {
      database.close();
    }
  });

  test("approve creates issue proposal with rendered repo context pack body", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const project = mustGetProject(database, "demo");
      const action = createPiRunnerActions(database, { project })
        .createIssueProposal({
          context_pack: {
            acceptance_criteria: ["User can collapse panel"],
            evidence: [{
              excerpt: "SECRET=super-secret\nexport function Panel() {}",
              path: "src/Panel.tsx",
              source_kind: "code",
              summary: "Panel component"
            }],
            intent: "Implement accordion panel",
            project: { id: "demo" },
            proposed_changes: ["Add accessible toggle"],
            validation: ["bun test src/Panel.test.tsx"]
          },
          description: "Need implementation\nTOKEN=must-not-leak",
          open_questions: ["默认展开吗？"],
          title: "Repo context issue"
        }) as { action_id: string };
      const router = createDefaultRouter({ database });

      const response = await postAction(router, action.action_id, "approve");
      const created = listIssues(database, { projectId: "demo" }).find((issue) => issue.title === "Repo context issue");

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: action.action_id, status: "completed" });
      expect(created).toMatchObject({ status: "triage", title: "Repo context issue" });
      expect(created?.description).toContain("## 需求理解");
      expect(created?.description).toContain("## 相关证据");
      expect(created?.description).toContain("src/Panel.tsx");
      expect(created?.description).toContain("bun test src/Panel.test.tsx");
      expect(created?.description).not.toContain("super-secret");
      expect(created?.description).not.toContain("must-not-leak");
    } finally {
      database.close();
    }
  });

  test("execute steers approved session actions through provider once", async () => {
    const database = await openFixtureDatabase();
    const provider = new SessionSteerProvider();
    try {
      insertProject(database, "demo");
      insertAgentSession(database, "demo", "codex:thread-1", "turn-1");
      createPiAction(database, {
        id: "steer-action",
        action_type: "session.steer", gate_decision: "ask",
        project_id: "demo",
        status: "approved",
        payload_json: JSON.stringify({ prompt: "adjust plan", session_key: "codex:thread-1" })
      });
      const router = createDefaultRouter({ database, providers: { codex: provider } });

      const first = await postAction(router, "steer-action", "execute");
      const second = await postAction(router, "steer-action", "execute");

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await first.json()).toMatchObject({ id: "steer-action", status: "completed" });
      expect(await second.json()).toMatchObject({ id: "steer-action", status: "completed" });
      expect(provider.calls).toEqual([{ mode: "steer", prompt: "adjust plan", sessionId: "thread-1", turnId: "turn-1" }]);
      expect(getPiAction(database, "steer-action")?.result_json).toContain("turn-steered");
    } finally {
      database.close();
    }
  });

  test("approve executes role workflow and needs_user escalation actions", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const project = mustGetProject(database, "demo");
      const issueID = insertIssue(database, project.id, { status: "pending_verification" });
      insertAgentProfile(database, "executor-codex");
      const actions = createPiRunnerActions(database, { project });
      const assign = actions.assignExecutorProfileProposal({
        agent_profile_id: "executor-codex",
        issue_id: issueID,
        rationale: "use executor profile"
      }) as { action_id: string };
      const verify = actions.createVerificationWorkflow({
        target_issue_id: issueID,
        instructions: "verify evidence",
        verification_plan: "bun test"
      }) as { action_id: string };
      const escalation = actions.escalateNeedsUser({
        issue_id: issueID,
        reason: "missing approval",
        requested_action: "confirm deploy window"
      }) as { action_id: string };
      const router = createDefaultRouter({ database });

      const assigned = await postAction(router, assign.action_id, "approve");
      const verified = await postAction(router, verify.action_id, "approve");
      const escalated = await postAction(router, escalation.action_id, "approve");
      const created = listIssues(database, { projectId: "demo" }).find((issue) => issue.id !== issueID);

      expect(assigned.status).toBe(200);
      expect(verified.status).toBe(200);
      expect(escalated.status).toBe(200);
      expect(await verified.json()).toMatchObject({ id: verify.action_id, status: "completed" });
      expect(await escalated.json()).toMatchObject({ id: escalation.action_id, status: "completed" });
      expect(getIssue(database, issueID)).toMatchObject({ agent_profile_id: "executor-codex" });
      expect(created).toMatchObject({
        agent_profile_id: "",
        status: "todo",
        title: expect.stringContaining(`Verifier: #${issueID}`)
      });
      expect(JSON.parse(created?.workflow_snapshot_json ?? "{}")).toMatchObject({
        agent_role: "verifier",
        parent_issue_id: issueID
      });
      expect(listEvents(database).map((event) => event.type)).toEqual(["issue.created", "issue.comment"]);
      expect(listEvents(database)[1]?.payload).toContain("needs_user");
    } finally {
      database.close();
    }
  });

});

function postAction(
  router: ReturnType<typeof createDefaultRouter>,
  id: string,
  action: "approve" | "execute" | "reject"
): Promise<Response> {
  return router.handle(new Request(`${BASE_URL}/api/pi/actions/${id}/${action}`, {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json" }
  }));
}

function insertAgentProfile(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into agent_profiles (id, name, provider, model, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [id, id, "codex", "gpt-test", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "codex", '{"capabilities":["issue_execution"]}', 1,
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectID: string, patch: Record<string, string> = {}): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, error, created_at, updated_at) values (?, ?, ?, ?, ?, ?)`,
    [projectID, "Queue me", patch.status ?? "triage", patch.error ?? "", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing issue id");
  return row.id;
}

function insertAgentSession(db: RunnerDatabase, projectID: string, sessionKey: string, turnID: string): void {
  const [, sessionID] = sessionKey.split(":");
  db.sqlite.run(
    `insert into agent_sessions
      (session_key, provider, provider_session_id, project_id, title, status, raw_ref, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sessionKey,
      "codex",
      sessionID,
      projectID,
      "Thread 1",
      "running",
      JSON.stringify({ provider_turn_id: turnID }),
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z"
    ]
  );
}

function listEvents(db: RunnerDatabase): Array<{ payload: string; type: string }> {
  return db.sqlite.query<{ payload: string; type: string }, []>(
    "select type, payload from issue_events order by id asc"
  ).all();
}

function mustGetProject(db: RunnerDatabase, id: string): Project {
  const project = getProject(db, id);
  if (!project) throw new Error("missing project");
  return project;
}

class SessionSteerProvider implements ExecutorProvider {
  readonly capabilities = ["resume_session"] as const;
  readonly calls: Record<string, unknown>[] = [];
  readonly id = "codex" as const;

  async run(_input: ProviderRunInput): Promise<never> {
    throw new Error("not implemented");
  }

  async sendSessionMessage(input: SessionMessageInput) {
    this.calls.push({
      mode: input.mode,
      prompt: input.prompt,
      sessionId: input.sessionId,
      turnId: input.turnId
    });
    return {
      provider: "codex" as const,
      provider_session_id: input.sessionId,
      sessionId: input.sessionId,
      turn_id: "turn-steered"
    };
  }
}
