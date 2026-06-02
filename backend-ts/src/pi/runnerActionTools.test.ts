import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import type { AgentSession } from "../db/repositories/agentSessions.ts";
import { getIssue, listIssues } from "../db/repositories/issues.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { getPiAction, listPiActionEvents, listPiActions } from "../db/repositories/pi.ts";
import { getProject, type Project } from "../db/repositories/projects.ts";
import { createPiRunnerActions, type PiRunnerActionLayer } from "./runnerActions.ts";
import { createPiRunnerActionTools, PI_RUNNER_ACTION_TOOL_NAMES } from "./runnerActionTools.ts";

describe("PI runner action tools", () => {
  test("defines schemas and delegates tool calls to the action layer", async () => {
    const calls: Array<[string, unknown]> = [];
    const tools = createPiRunnerActionTools(fakeActions(calls));
    const issueRead = toolByName(tools, "issue_read");
    const diagnose = toolByName(tools, "issue_state_diagnose");
    const steer = toolByName(tools, "session_steer_proposal");

    expect(tools.map((tool) => tool.name).sort()).toEqual([...PI_RUNNER_ACTION_TOOL_NAMES].sort());
    expect(validateArgs(issueRead, { id: 1 })).toEqual({ id: 1 });
    expect(validateArgs(diagnose, { project_id: "demo" })).toEqual({ project_id: "demo" });
    expect(validateArgs(steer, { session_key: "codex:thread-1", prompt: "adjust" })).toEqual({
      session_key: "codex:thread-1",
      prompt: "adjust"
    });
    expect(() => validateArgs(issueRead, { id: "bad" })).toThrow(/Validation failed/);
    expect(() => validateArgs(issueRead, { id: 1, unexpected: true })).toThrow(/Validation failed/);
    expect(() => validateArgs(steer, { session_key: "codex:thread-1", prompt: " " })).toThrow(/Validation failed/);

    await issueRead.execute("tool-1", { id: 7 }, undefined, undefined, {} as never);
    await diagnose.execute("tool-diagnose", { project_id: "demo" }, undefined, undefined, {} as never);
    await steer.execute("tool-2", { session_key: "codex:thread-1", prompt: "adjust" }, undefined, undefined, {} as never);

    expect(calls).toEqual([
      ["readIssue", { id: 7 }],
      ["diagnoseIssueState", { project_id: "demo" }],
      ["createSessionSteerProposal", { session_key: "codex:thread-1", prompt: "adjust" }]
    ]);
  });

  test("creates high-risk proposals without mutating issues or sessions", async () => {
    const fixture = await openFixture();
    try {
      const actions = createPiRunnerActions(fixture.db, { project: fixture.project });
      const tools = createPiRunnerActionTools(actions);
      const issueID = insertIssue(fixture.db, { projectID: fixture.project.id, status: "triage", title: "Queue me" });
      insertAgentSession(fixture.db, { projectID: fixture.project.id, sessionKey: "codex:thread-1" });

      const createIssue = await runTool(tools, "issue_create_proposal", {
        description: "New scoped issue",
        title: "New issue"
      });
      const updateRefinement = await runTool(tools, "issue_update_refinement", {
        issue_id: issueID,
        acceptance_criteria: "- passes",
        verification_plan: "bun test"
      });
      const enqueue = await runTool(tools, "issue_enqueue_proposal", { issue_id: issueID, rationale: "ready" });
      const steer = await runTool(tools, "session_steer_proposal", {
        session_key: "codex:thread-1",
        prompt: "Please adjust the plan"
      });

      expect(createIssue.details).toMatchObject({
        action_type: "issue.create",
        requires_confirmation: true,
        status: "pending"
      });
      expect(updateRefinement.details).toMatchObject({
        action_type: "issue.update_refinement",
        issue_id: issueID,
        requires_confirmation: true,
        status: "pending"
      });
      expect(enqueue.details).toMatchObject({
        action_type: "issue.enqueue",
        issue_id: issueID,
        requires_confirmation: true,
        status: "pending"
      });
      expect(steer.details).toMatchObject({
        action_type: "session.steer",
        requires_confirmation: true,
        status: "pending"
      });
      expect(getIssue(fixture.db, issueID)?.status).toBe("triage");
      expect(getIssue(fixture.db, issueID)?.description).toBe("");
      expect(listIssues(fixture.db, { projectId: fixture.project.id })).toHaveLength(1);
      expect(listPiActions(fixture.db).map((action) => action.action_type).sort()).toEqual([
        "issue.create",
        "issue.enqueue",
        "issue.update_refinement",
        "session.steer"
      ]);
      const steerAction = listPiActions(fixture.db).find((action) => action.action_type === "session.steer");
      expect(JSON.parse(steerAction?.payload_json ?? "{}")).toMatchObject({
        progress_context: expect.stringContaining("state=active")
      });
    } finally {
      await fixture.close();
    }
  });

  test("global Runner project_status summarizes all projects without project_id", async () => {
    const fixture = await openFixture();
    try {
      const actions = createPiRunnerActions(fixture.db);

      expect(actions.projectStatus({})).toMatchObject({
        items: [{ id: fixture.project.id, name: fixture.project.name, status: "active" }]
      });
      expect(listPiActions(fixture.db, { status: "completed" })).toContainEqual(expect.objectContaining({
        action_type: "project.status",
        project_id: "",
        payload_json: "{}"
      }));
    } finally {
      await fixture.close();
    }
  });

  test("executes safe reads and low-risk comments through the action layer", async () => {
    const fixture = await openFixture();
    try {
      const actions = createPiRunnerActions(fixture.db, { project: fixture.project });
      const issueID = insertIssue(fixture.db, { projectID: fixture.project.id, status: "todo", title: "Read me" });
      insertAgentSession(fixture.db, { projectID: fixture.project.id, sessionKey: "codex:thread-1" });

      expect(actions.listIssues({ status: "todo" })).toMatchObject({ items: [{ id: issueID, title: "Read me" }] });
      expect(actions.readIssue({ id: issueID })).toMatchObject({ id: issueID, title: "Read me" });
      expect(projectIDs(actions.listProjects({}))).toContain(fixture.project.id);
      expect(sessionKeys(actions.listSessions({}))).toEqual(["codex:thread-1"]);
      expect(actions.readSessionSummary({ session_key: "codex:thread-1" })).toMatchObject({
        progress: expect.objectContaining({ progress_state: "active" })
      });

      const comment = actions.commentIssue({ issue_id: issueID, body: "Looks actionable." });

      expect(comment).toMatchObject({ type: "issue.comment", issue_id: issueID });
      const completedActions = listPiActions(fixture.db, { status: "completed" });
      expect(completedActions.map((action) => action.action_type).sort()).toEqual([
        "issue.comment", "issue.list", "issue.read", "project.list", "session.list", "session.read_summary"
      ]);
      expect(completedActions).toContainEqual(expect.objectContaining({
        action_type: "issue.comment",
        issue_id: issueID,
        result_json: expect.stringContaining("issue.comment"),
        risk_level: "low"
      }));
      const commentAction = completedActions.find((action) => action.action_type === "issue.comment");
      expect(getPiAction(fixture.db, commentAction?.id ?? "")).toMatchObject({
        action_type: "issue.comment",
        gate_decision: "execute",
        issue_id: issueID,
        result_json: expect.stringContaining("issue.comment"),
        source: "pi_tool",
        status: "completed"
      });
      expect(listPiActionEvents(fixture.db, { actionId: commentAction?.id ?? "" }).map((event) => event.event_type)).toEqual([
        "candidate",
        "gate_decision",
        "execution_started",
        "execution_result"
      ]);
      expect(listIssueEvents(fixture.db, issueID).map((event) => event.type)).toEqual([
        "issue.comment"
      ]);
      expect(listIssues(fixture.db, { projectId: fixture.project.id })[0]?.comment_count).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  test("keeps confirm-required actions pending and records rationale/result", async () => {
    const fixture = await openFixture();
    try {
      const actions = createPiRunnerActions(fixture.db, {
        conversationID: "conv-1",
        project: fixture.project
      });
      const issueID = insertIssue(fixture.db, { projectID: fixture.project.id, status: "triage", title: "Queue me" });

      const action = actions.enqueueIssueProposal({ issue_id: issueID, rationale: "ready to run" }) as {
        action_id: string;
      };
      const stored = getPiAction(fixture.db, action.action_id);

      expect(stored).toMatchObject({
        action_type: "issue.enqueue",
        conversation_id: "conv-1",
        issue_id: issueID,
        payload_json: JSON.stringify({ issue_id: issueID }),
        project_id: fixture.project.id,
        rationale: "ready to run",
        requires_confirmation: 1,
        result_json: expect.stringContaining("pending"),
        risk_level: "medium",
        status: "pending"
      });
      expect(action).toMatchObject({
        action_type: "issue.enqueue",
        decision: "ask",
        requires_confirmation: true,
        risk_level: "medium",
        status: "pending"
      });
      expect(listPiActionEvents(fixture.db, { actionId: action.action_id }).map((event) => event.event_type)).toEqual([
        "candidate",
        "gate_decision",
        "pending_approval"
      ]);
    } finally {
      await fixture.close();
    }
  });
});
function projectIDs(result: unknown): string[] {
  return (result as { items: Project[] }).items.map((project) => project.id);
}
function sessionKeys(result: unknown): string[] {
  return (result as { items: AgentSession[] }).items.map((session) => session.session_key);
}
function fakeActions(calls: Array<[string, unknown]>): PiRunnerActionLayer {
  const record = (name: string) => (input: unknown) => {
    calls.push([name, input]);
    return { ok: true };
  };
  return {
    commentIssue: record("commentIssue"),
    createIssueProposal: record("createIssueProposal"),
    createIssueStateRepairProposal: record("createIssueStateRepairProposal"),
    diagnoseIssueState: record("diagnoseIssueState"),
    createSessionSteerProposal: record("createSessionSteerProposal"),
    createUpdateRefinementProposal: record("createUpdateRefinementProposal"),
    enqueueIssueProposal: record("enqueueIssueProposal"),
    listIssues: record("listIssues"),
    listProjects: record("listProjects"),
    listSessions: record("listSessions"),
    projectStatus: record("projectStatus"),
    readIssue: record("readIssue"),
    readSessionSummary: record("readSessionSummary")
  };
}
async function openFixture(): Promise<{ close(): Promise<void>; db: RunnerDatabase; project: Project }> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-action-tools-"));
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    ["demo", "Demo", join(root, "project"), 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const project = getProject(db, "demo");
  if (!project) throw new Error("missing fixture project");
  return { db, project, close: async () => { db.close(); await rm(root, { recursive: true, force: true }); } };
}
function insertIssue(db: RunnerDatabase, input: { projectID: string; status: string; title: string }): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [input.projectID, input.title, input.status, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing issue id");
  return row.id;
}
function insertAgentSession(db: RunnerDatabase, input: { projectID: string; sessionKey: string }): void {
  const [, sessionID] = input.sessionKey.split(":");
  db.sqlite.run(
    `insert into agent_sessions
      (session_key, provider, provider_session_id, project_id, title, status, raw_ref, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.sessionKey, "codex", sessionID, input.projectID, "Thread 1", "running",
      '{"provider_turn_id":"turn-1"}', "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"
    ]
  );
}
function toolByName(tools: ReturnType<typeof createPiRunnerActionTools>, name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}
function validateArgs(tool: ReturnType<typeof toolByName>, args: Record<string, unknown>) {
  return validateToolArguments(tool as never, { name: tool.name, arguments: args } as never);
}
async function runTool(
  tools: ReturnType<typeof createPiRunnerActionTools>,
  name: string,
  params: Record<string, unknown>
) {
  return toolByName(tools, name).execute("tool-call", params as never, undefined, undefined, {} as never);
}
