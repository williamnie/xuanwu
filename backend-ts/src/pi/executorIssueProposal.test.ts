import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listIssues } from "../db/repositories/issues.ts";
import { getPiAction, listPiActionEvents } from "../db/repositories/pi.ts";
import { getProject, type Project } from "../db/repositories/projects.ts";
import { createDefaultRouter } from "../http/server.ts";
import { createPiRunnerActions } from "./runnerActions.ts";
import { createPiRunnerActionTools } from "./runnerActionTools.ts";

const BASE_URL = "http://127.0.0.1:3008";

describe("PI executor issue proposal", () => {
  test("accepts goal intent through the executor issue tool schema", () => {
    const tool = createPiRunnerActionTools(createPiRunnerActions(fakeFixture().db))
      .find((item) => item.name === "executor_issue_create_proposal");

    if (!tool) throw new Error("missing executor issue tool");
    const toolCall = { name: tool.name, arguments: { goal_id: "epic-217", target_issue_id: 1 } };

    expect(validateToolArguments(tool as never, toolCall as never)).toEqual({
      goal_id: "epic-217",
      target_issue_id: 1
    });
  });

  test("keeps executor proposal pending with parent, profile, skill intents, and audit source", async () => {
    const fixture = await openFixture();
    try {
      insertAgentProfile(fixture.db, "executor-codex", "[\"codex-issue-runner\"]");
      const parentID = insertIssue(fixture.db, fixture.project.id);

      const action = createPiRunnerActions(fixture.db, { project: fixture.project }).createExecutorIssueProposal({
        agent_profile_id: "executor-codex",
        goal_id: "epic-217",
        instructions: "Implement the focused follow-up.",
        recommended_skill_intents: ["verification-before-completion"],
        required_skill_intents: ["codex-issue-runner"],
        target_issue_id: parentID
      }) as { action_id: string };
      const proposal = readAction(fixture.db, action.action_id);

      expect(listIssues(fixture.db, { projectId: fixture.project.id })).toHaveLength(1);
      expect(proposal.action).toMatchObject({
        action_type: "agent.workflow_request",
        issue_id: parentID,
        status: "pending"
      });
      expect(proposal.payload).toMatchObject({
        agent_profile_id: "executor-codex",
        goal_id: "epic-217",
        parent_issue_id: parentID,
        recommended_skill_intents: ["verification-before-completion"],
        required_skill_intents: ["codex-issue-runner"],
        status: "triage"
      });
      expect(String(proposal.payload.source_excerpt)).toContain(`parent_issue_id=${parentID}`);
      expect(String(proposal.payload.source_excerpt)).toContain("goal_id=epic-217");
      expect(proposal.snapshot).toMatchObject({
        agent_role: "executor",
        goal_id: "epic-217",
        parent_issue_id: parentID,
        recommended_profile_id: "executor-codex"
      });
      expect(proposal.audit).toMatchObject({
        goal_id: "epic-217",
        issue_id: parentID,
        payload: { parent_issue_id: parentID },
        source: "pi_tool"
      });
    } finally {
      await fixture.close();
    }
  });

  test("approved executor proposal creates triage issue without enqueueing", async () => {
    const fixture = await openFixture();
    try {
      insertAgentProfile(fixture.db, "executor-codex", "[\"codex-issue-runner\"]");
      const parentID = insertIssue(fixture.db, fixture.project.id);
      const action = createPiRunnerActions(fixture.db, { project: fixture.project }).createExecutorIssueProposal({
        agent_profile_id: "executor-codex",
        goal_id: "epic-217",
        recommended_skill_intents: ["verification-before-completion"],
        required_skill_intents: ["codex-issue-runner"],
        target_issue_id: parentID
      }) as { action_id: string };

      const response = await postAction(createDefaultRouter({ database: fixture.db }), action.action_id);
      const created = listIssues(fixture.db, { projectId: fixture.project.id }).find((issue) => issue.id !== parentID);
      const snapshot = jsonObject(created?.workflow_snapshot_json);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: action.action_id, status: "completed" });
      expect(created).toMatchObject({
        agent_profile_id: "executor-codex",
        recommended_skill_intents: "[\"verification-before-completion\"]",
        required_skill_intents: "[\"codex-issue-runner\"]",
        source_excerpt: expect.stringContaining("goal_id=epic-217"),
        status: "triage"
      });
      expect(snapshot).toMatchObject({
        agent_role: "executor",
        goal_id: "epic-217",
        parent_issue_id: parentID,
        recommended_profile_id: "executor-codex"
      });
    } finally {
      await fixture.close();
    }
  });
});

function fakeFixture(): { db: RunnerDatabase } {
  return { db: { sqlite: {} } as RunnerDatabase["sqlite"] } as RunnerDatabase;
}

async function openFixture(): Promise<{ close(): Promise<void>; db: RunnerDatabase; project: Project }> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-executor-issue-proposal-"));
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    ["demo", "Demo", join(root, "project"), "codex", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const project = getProject(db, "demo");
  if (!project) throw new Error("missing fixture project");
  return { db, project, close: async () => { db.close(); await rm(root, { recursive: true, force: true }); } };
}

function insertAgentProfile(db: RunnerDatabase, id: string, skillIntents: string): void {
  db.sqlite.run(
    `insert into agent_profiles (id, name, provider, model, skill_intents_json, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [id, id, "codex", "gpt-test", skillIntents, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectID: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [projectID, "Parent task", "triage", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing issue id");
  return row.id;
}

function readAction(db: RunnerDatabase, actionID: string) {
  const action = getPiAction(db, actionID);
  if (!action) throw new Error("missing PI action");
  const payload = jsonObject(action.payload_json);
  return {
    action,
    audit: jsonObject(listPiActionEvents(db, { actionId: actionID })[0]?.payload_json),
    payload,
    snapshot: jsonObject(String(payload.workflow_snapshot_json ?? "{}"))
  };
}

function postAction(router: ReturnType<typeof createDefaultRouter>, id: string): Promise<Response> {
  return router.handle(new Request(`${BASE_URL}/api/pi/actions/${id}/approve`, {
    body: "{}",
    headers: { "content-type": "application/json" },
    method: "POST"
  }));
}

function jsonObject(text: string | undefined): Record<string, unknown> {
  return JSON.parse(text || "{}") as Record<string, unknown>;
}
