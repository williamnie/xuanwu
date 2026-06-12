import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listCronTasks } from "../db/repositories/cronTasks.ts";
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
    const recommendProfile = toolByName(tools, "agent_profile_recommend");
    const verifier = toolByName(tools, "verification_workflow_request");
    const issueRead = toolByName(tools, "issue_read");
    const diagnose = toolByName(tools, "issue_state_diagnose");
    const schedule = toolByName(tools, "issue_schedule_enqueue");
    const steer = toolByName(tools, "session_steer_proposal");
    const repoSearch = toolByName(tools, "repo_search");
    const repoRead = toolByName(tools, "repo_read_excerpt");
    const repoTree = toolByName(tools, "repo_tree");

    expect(tools.map((tool) => tool.name).sort()).toEqual([...PI_RUNNER_ACTION_TOOL_NAMES].sort());
    expect(validateArgs(issueRead, { id: 1 })).toEqual({ id: 1 });
    expect(validateArgs(recommendProfile, { issue_id: 1, role: "executor" })).toEqual({ issue_id: 1, role: "executor" });
    expect(validateArgs(verifier, { target_issue_id: 1, instructions: "verify" })).toEqual({
      target_issue_id: 1,
      instructions: "verify"
    });
    expect(validateArgs(diagnose, { project_id: "demo" })).toEqual({ project_id: "demo" });
    expect(validateArgs(schedule, { issue_id: 1, next_run_at: "2999-01-01T00:00:00.000Z" })).toEqual({
      issue_id: 1,
      next_run_at: "2999-01-01T00:00:00.000Z"
    });
    expect(validateArgs(repoSearch, { query: "Accordion", max_results: 3 })).toEqual({
      query: "Accordion",
      max_results: 3
    });
    expect(validateArgs(repoRead, { path: "src/App.tsx", start_line: 2, max_lines: 4 })).toEqual({
      path: "src/App.tsx",
      start_line: 2,
      max_lines: 4
    });
    expect(validateArgs(repoTree, { path: "src", max_depth: 2 })).toEqual({ path: "src", max_depth: 2 });
    expect(validateArgs(steer, { session_key: "codex:thread-1", prompt: "adjust" })).toEqual({
      session_key: "codex:thread-1",
      prompt: "adjust"
    });
    expect(() => validateArgs(issueRead, { id: "bad" })).toThrow(/Validation failed/);
    expect(() => validateArgs(issueRead, { id: 1, unexpected: true })).toThrow(/Validation failed/);
    expect(() => validateArgs(steer, { session_key: "codex:thread-1", prompt: " " })).toThrow(/Validation failed/);

    await recommendProfile.execute("tool-profile", { issue_id: 1, role: "executor" }, undefined, undefined, {} as never);
    await verifier.execute("tool-verifier", { target_issue_id: 1, instructions: "verify" }, undefined, undefined, {} as never);
    await issueRead.execute("tool-1", { id: 7 }, undefined, undefined, {} as never);
    await diagnose.execute("tool-diagnose", { project_id: "demo" }, undefined, undefined, {} as never);
    await repoSearch.execute("tool-repo-search", { query: "Accordion", max_results: 3 }, undefined, undefined, {} as never);
    await repoRead.execute("tool-repo-read", { path: "src/App.tsx" }, undefined, undefined, {} as never);
    await repoTree.execute("tool-repo-tree", { path: "src" }, undefined, undefined, {} as never);
    await schedule.execute("tool-schedule", {
      issue_id: 3,
      next_run_at: "2999-01-01T00:00:00.000Z"
    }, undefined, undefined, {} as never);
    await steer.execute("tool-2", { session_key: "codex:thread-1", prompt: "adjust" }, undefined, undefined, {} as never);

    expect(calls).toEqual([
      ["recommendExecutorProfile", { issue_id: 1, role: "executor" }],
      ["createVerificationWorkflow", { target_issue_id: 1, instructions: "verify" }],
      ["readIssue", { id: 7 }],
      ["diagnoseIssueState", { project_id: "demo" }],
      ["searchRepo", { query: "Accordion", max_results: 3 }],
      ["readRepoExcerpt", { path: "src/App.tsx" }],
      ["readRepoTree", { path: "src" }],
      ["scheduleIssueEnqueue", { issue_id: 3, next_run_at: "2999-01-01T00:00:00.000Z" }],
      ["createSessionSteerProposal", { session_key: "codex:thread-1", prompt: "adjust" }]
    ]);
  });

  test("creates high-risk proposals without mutating issues or sessions", async () => {
    const fixture = await openFixture();
    try {
      const actions = createPiRunnerActions(fixture.db, { project: fixture.project });
      const tools = createPiRunnerActionTools(actions);
      const issueID = insertIssue(fixture.db, { projectID: fixture.project.id, status: "triage", title: "Queue me" });
      insertAgentSession(fixture.db, { projectID: fixture.project.id, role: "verifier", sessionKey: "codex:thread-1" });
      insertAgentSession(fixture.db, { projectID: fixture.project.id, role: "reporter", sessionKey: "codex:thread-2" });

      const createIssue = await runTool(tools, "issue_create_proposal", {
        description: "New scoped issue",
        title: "New issue"
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
      insertAgentSession(fixture.db, { projectID: fixture.project.id, role: "verifier", sessionKey: "codex:thread-1" });
      insertAgentSession(fixture.db, { projectID: fixture.project.id, role: "reporter", sessionKey: "codex:thread-2" });

      expect(actions.listIssues({ status: "todo" })).toMatchObject({ items: [{ id: issueID, title: "Read me" }] });
      expect(actions.readIssue({ id: issueID })).toMatchObject({ id: issueID, title: "Read me" });
      expect(projectIDs(actions.listProjects({}))).toContain(fixture.project.id);
      expect(sessionKeys(actions.listSessions({ role: "verifier" }))).toEqual(["codex:thread-1"]);
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

  test("repo read-only actions are scoped, bounded, redacted, and audited", async () => {
    const fixture = await openFixture();
    try {
      mkdirSync(fixture.project.cwd, { recursive: true });
      writeFileSync(join(fixture.project.cwd, "README.md"), "# Demo\nTOKEN=secret\nneedle line\n");
      mkdirSync(join(fixture.project.cwd, "src"), { recursive: true });
      writeFileSync(join(fixture.project.cwd, "src", "App.tsx"), "export const App = 'needle';\n");
      mkdirSync(join(fixture.project.cwd, ".git"), { recursive: true });
      writeFileSync(join(fixture.project.cwd, ".git", "config"), "[core]\n");
      writeFileSync(join(fixture.project.cwd, "large.txt"), "x".repeat(4097));
      writeFileSync(join(fixture.project.cwd, "secret.token"), "needle\n");
      const actions = createPiRunnerActions(fixture.db, { project: fixture.project });

      expect(actions.readRepoTree({ path: ".", max_depth: 2 })).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({ path: "README.md", source: "repo_tree" }),
          expect.objectContaining({ path: "src", type: "directory" })
        ]),
        skipped: expect.arrayContaining([
          expect.objectContaining({ path: ".git", reason: expect.stringContaining("sensitive") }),
          expect.objectContaining({ path: "secret.token", reason: expect.stringContaining("sensitive") })
        ])
      });
      const searchResult = actions.searchRepo({ query: "needle", max_results: 5 });
      expect(searchResult).toMatchObject({
        truncated: false,
        results: [
          expect.objectContaining({ line_range: { end: 3, start: 3 }, path: "README.md", source: "repo_search" }),
          expect.objectContaining({ path: "src/App.tsx", source: "repo_search" })
        ],
        skipped: expect.arrayContaining([
          expect.objectContaining({ path: "large.txt", reason: expect.stringContaining("exceeds") }),
          expect.objectContaining({ path: "secret.token", reason: expect.stringContaining("sensitive") })
        ])
      });
      expect(actions.searchRepo({ query: "needle", max_results: 1 })).toMatchObject({
        results: [expect.objectContaining({ path: "README.md" })],
        truncated: true
      });
      const excerpt = actions.readRepoExcerpt({ path: "README.md", start_line: 1, max_lines: 3 });
      expect(excerpt).toMatchObject({
        excerpt: expect.stringContaining("TOKEN=[redacted]"),
        line_range: { end: 3, start: 1 },
        path: "README.md",
        source: "repo_read_excerpt"
      });
      expect(JSON.stringify(excerpt)).not.toContain("TOKEN=secret");
      expect(() => actions.readRepoExcerpt({ path: "../outside.txt" })).toThrow(/project scope/);
      expect(() => actions.readRepoExcerpt({ path: join(fixture.project.cwd, "README.md") })).toThrow(/absolute/);
      expect(() => actions.readRepoExcerpt({ path: ".git/config" })).toThrow(/sensitive/);
      expect(() => actions.readRepoExcerpt({ path: "large.txt" })).toThrow(/exceeds/);
      expect(readFileSync(join(fixture.project.cwd, "README.md"), "utf8")).toBe("# Demo\nTOKEN=secret\nneedle line\n");
      const repoActions = listPiActions(fixture.db).filter((action) => action.action_type.startsWith("repo."));

      expect(repoActions.map((action) => action.action_type).sort()).toEqual([
        "repo.read_excerpt",
        "repo.read_excerpt",
        "repo.read_excerpt",
        "repo.read_excerpt",
        "repo.read_excerpt",
        "repo.search",
        "repo.search",
        "repo.tree"
      ]);
      expect(repoActions.every((action) => !action.result_json.includes("TOKEN=secret"))).toBe(true);
      const auditedSearch = repoActions.find((action) => action.payload_json.includes('"max_results":5'));
      expect(JSON.parse(auditedSearch?.payload_json ?? "{}")).toEqual({
        max_results: 5,
        query: "needle"
      });
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

  test("delegated runner chat can schedule one issue enqueue through a real once cron", async () => {
    const fixture = await openFixture();
    try {
      const issueID = insertIssue(fixture.db, { projectID: fixture.project.id, status: "triage", title: "Schedule me" });
      const actions = createPiRunnerActions(fixture.db, {
        authorization: {
          authorizedActions: [{ action_type: "issue.schedule_enqueue", issue_id: issueID, project_id: fixture.project.id }],
          mode: "delegated",
          scope: { project_id: fixture.project.id }
        },
        conversationID: "conv-chat",
        project: fixture.project
      });

      const result = actions.scheduleIssueEnqueue({
        issue_id: issueID,
        next_run_at: "2999-01-01T00:00:00.000Z",
        rationale: "user picked later"
      }) as { action_id: string; decision: string; status: string };
      const cron = listCronTasks(fixture.db)[0];

      expect(result).toMatchObject({ decision: "execute", status: "completed" });
      expect(getPiAction(fixture.db, result.action_id)).toMatchObject({
        action_type: "issue.schedule_enqueue",
        conversation_id: "conv-chat",
        gate_decision: "execute",
        issue_id: issueID,
        status: "completed"
      });
      expect(cron).toMatchObject({
        action: "enqueue_issues",
        mode: "once",
        next_run_at: "2999-01-01T00:00:00.000Z",
        project_id: fixture.project.id,
        status: "active"
      });
      expect(JSON.parse(cron?.action_payload_json ?? "{}")).toEqual({ issue_ids: [issueID] });
      expect(getIssue(fixture.db, issueID)?.status).toBe("triage");
    } finally {
      await fixture.close();
    }
  });

  test("delegated runner chat issue creation returns the created issue id", async () => {
    const fixture = await openFixture();
    try {
      const actions = createPiRunnerActions(fixture.db, {
        authorization: {
          authorizedActions: [{ action_type: "issue.create", project_id: fixture.project.id }],
          mode: "delegated",
          scope: { project_id: fixture.project.id }
        },
        conversationID: "conv-chat",
        project: fixture.project
      });

      const result = actions.createIssueProposal({
        description: "Create and then ask when to run",
        title: "Chat-created issue"
      }) as { result?: { id?: number }; status: string };

      expect(result).toMatchObject({
        decision: "execute",
        result: { id: 1, status: "triage", title: "Chat-created issue" },
        status: "completed"
      });
      expect(getIssue(fixture.db, 1)).toMatchObject({ title: "Chat-created issue" });
    } finally {
      await fixture.close();
    }
  });

  test("orchestrates role workflows through gated PI actions and issue linkage", async () => {
    const fixture = await openFixture();
    try {
      insertAgentProfile(fixture.db, {
        id: "verifier-codex",
        name: "Verifier Codex",
        skillIntents: "[\"verification-before-completion\"]"
      });
      insertAgentProfile(fixture.db, { id: "reporter-codex", name: "Reporter Codex", skillIntents: "[\"codex-issue-runner\"]" });
      const actions = createPiRunnerActions(fixture.db, { project: fixture.project });
      const issueID = insertIssue(fixture.db, { projectID: fixture.project.id, status: "pending_verification", title: "Ready" });

      const recommendation = actions.recommendExecutorProfile({ issue_id: issueID, role: "verifier" });
      const verifier = actions.createVerificationWorkflow({
        target_issue_id: issueID,
        instructions: "Check tests and evidence",
        verification_plan: "bun test",
        rationale: "ready for verifier"
      }) as { action_id: string };
      const reporter = actions.createReportWorkflow({ report_type: "nightly", title: "Nightly report" }) as { action_id: string };
      const reviewer = actions.createReviewWorkflow({ target_issue_id: issueID, instructions: "review patch" }) as { action_id: string };
      const escalation = actions.escalateNeedsUser({
        issue_id: issueID,
        reason: "missing production smoke",
        requested_action: "provide smoke window"
      }) as { action_id: string };

      expect(recommendation).toMatchObject({ agent_role: "verifier", profile_id: "verifier-codex" });
      expect(listPiActions(fixture.db, { status: "completed" })).toContainEqual(expect.objectContaining({
        action_type: "agent.profile_recommend",
        gate_decision: "execute",
        project_id: fixture.project.id
      }));
      expect(getPiAction(fixture.db, verifier.action_id)).toMatchObject({
        action_type: "agent.workflow_request",
        issue_id: issueID,
        status: "pending"
      });
      expect(JSON.parse(getPiAction(fixture.db, verifier.action_id)?.payload_json ?? "{}")).toMatchObject({
        agent_profile_id: "verifier-codex",
        source_excerpt: expect.stringContaining(`parent_issue_id=${issueID}`),
        workflow_snapshot_json: expect.stringContaining("\"agent_role\":\"verifier\"")
      });
      expect(JSON.parse(getPiAction(fixture.db, reporter.action_id)?.payload_json ?? "{}")).toMatchObject({
        title: "Nightly report",
        workflow_snapshot_json: expect.stringContaining("\"agent_role\":\"reporter\"")
      });
      expect(JSON.parse(getPiAction(fixture.db, reviewer.action_id)?.payload_json ?? "{}")).toMatchObject({
        title: expect.stringContaining(`Reviewer: #${issueID}`),
        workflow_snapshot_json: expect.stringContaining("\"agent_role\":\"reviewer\"")
      });
      expect(getPiAction(fixture.db, escalation.action_id)).toMatchObject({
        action_type: "needs_user.escalate",
        issue_id: issueID,
        status: "pending"
      });
      expect(getIssue(fixture.db, issueID)?.comment_count).toBe(0);
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
    assignExecutorProfileProposal: record("assignExecutorProfileProposal"),
    createExecutorIssueProposal: record("createExecutorIssueProposal"),
    createIssueProposal: record("createIssueProposal"),
    createIssueStateRepairProposal: record("createIssueStateRepairProposal"),
    createReportWorkflow: record("createReportWorkflow"),
    createReviewWorkflow: record("createReviewWorkflow"),
    createVerificationWorkflow: record("createVerificationWorkflow"),
    diagnoseIssueState: record("diagnoseIssueState"),
    escalateNeedsUser: record("escalateNeedsUser"),
    createSessionSteerProposal: record("createSessionSteerProposal"),
    enqueueIssueProposal: record("enqueueIssueProposal"),
    listIssues: record("listIssues"),
    listMcpRegistry: record("listMcpRegistry"),
    listMcpResources: record("listMcpResources"),
    listProjects: record("listProjects"),
    listSessions: record("listSessions"),
    projectStatus: record("projectStatus"),
    listSkills: record("listSkills"),
    readIssue: record("readIssue"),
    readMcpCapability: record("readMcpCapability"),
    readMcpResource: record("readMcpResource"),
    readRepoExcerpt: record("readRepoExcerpt"),
    readRepoTree: record("readRepoTree"),
    readSessionSummary: record("readSessionSummary"),
    readSkill: record("readSkill"),
    scheduleIssueEnqueue: record("scheduleIssueEnqueue"),
    searchRepo: record("searchRepo"),
    recommendExecutorProfile: record("recommendExecutorProfile"),
    recommendMcpRequirements: record("recommendMcpRequirements"),
    recommendSkills: record("recommendSkills"),
    auditSkillIntents: record("auditSkillIntents")
  };
}

function insertAgentProfile(
  db: RunnerDatabase,
  input: { id: string; name: string; skillIntents: string }
): void {
  db.sqlite.run(
    `insert into agent_profiles (id, name, provider, model, reasoning_effort,
      approval_policy, sandbox, skill_intents_json, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id, input.name, "codex", "gpt-test", "high", "never",
      "workspace-write", input.skillIntents, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"
    ]
  );
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
function insertAgentSession(db: RunnerDatabase, input: { projectID: string; role?: string; sessionKey: string }): void {
  const [, sessionID] = input.sessionKey.split(":");
  db.sqlite.run(
    `insert into agent_sessions
      (session_key, provider, provider_session_id, agent_role, project_id, title, status, raw_ref, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.sessionKey, "codex", sessionID, input.role ?? "", input.projectID, "Thread 1", "running",
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
