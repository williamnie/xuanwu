import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { RunnerDatabase } from "../../db/database.ts";
import { listAutomations } from "../../db/repositories/automations.ts";
import type { AgentSession } from "../../db/repositories/agentSessions.ts";
import { getIssue, listIssueRuns, listIssues } from "../../db/repositories/issues.ts";
import { listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { createIssueRun } from "../../db/repositories/issueRuns.ts";
import { getPiAction, listPiActionEvents, listPiActions } from "../../db/repositories/pi.ts";
import { getProject, type Project } from "../../db/repositories/projects.ts";
import { createHumanReviewRequest, readIssueDecisionProjection } from "../../domain/review/humanReview.ts";
import { createPiRunnerActions, type PiRunnerActionLayer } from "./runnerActions.ts";
import { createPiRunnerActionTools, PI_RUNNER_ACTION_TOOL_NAMES } from "./runnerActionTools.ts";
import { insertIssue as insertIssueRow, insertProject, useTestDatabase } from "../../testing/harness.ts";

import { HUMAN_REVIEW, HUMAN_REVIEW_RESPONSE, BATCH, VALID_ARGUMENTS, INVALID_ARGUMENTS, DELEGATED_CALLS, openDatabase, projectIDs, sessionKeys, fakeActions, detailedBatchItem, insertAgentProfile, openFixture, insertIssue, insertAgentSession } from "./runnerActionToolsFixtureHUMAN_REVIEW.ts";
import { toolByName, validateArgs, collectToolText, runTool } from "./runnerActionToolsFixtureToolByName.ts";

export function registerDefinesSchemasAndDelegatesToolCalls() {
test("defines schemas and delegates tool calls to the action layer", async () => {
    const calls: Array<[string, unknown]> = [];
    const tools = createPiRunnerActionTools(fakeActions(calls));
    expect(tools.map((tool) => tool.name).sort()).toEqual([...PI_RUNNER_ACTION_TOOL_NAMES].sort());

    for (const [name, args] of VALID_ARGUMENTS) expect(validateArgs(toolByName(tools, name), args), name).toEqual(args);
    const humanReviewResponse = toolByName(tools, "human_review_response");
    expect(humanReviewResponse.description).toContain("For decision/risk_acceptance");
    expect(humanReviewResponse.description).toContain("must never be treated as accepting an incomplete delivery");
    const contextPack = {
      evidence: [{ path: "src/App.tsx", source_kind: "code", summary: "owner" }],
      intent: "Add panel",
      project: { id: "demo" }
    };
    expect(validateArgs(toolByName(tools, "issue_create_proposal"), {
      context_pack: contextPack,
      description: "Need repo context",
      evidence: [{ source_kind: "message", summary: "IM request" }],
      open_questions: ["默认展开吗？"],
      project_id: "demo",
      title: "Repo-aware issue"
    })).toMatchObject({
      context_pack: contextPack,
      evidence: [{ source_kind: "message", summary: "IM request" }],
      open_questions: ["默认展开吗？"]
    });
    expect(validateArgs(toolByName(tools, "issue_create_batch_proposal"), {
      project_id: "demo",
      items: [
        detailedBatchItem("foundation", "建立工程基线"),
        { ...detailedBatchItem("ui", "实现前端流程"), depends_on_refs: ["foundation"] }
      ]
    })).toMatchObject({
      items: [
        expect.objectContaining({ ref: "foundation" }),
        expect.objectContaining({ depends_on_refs: ["foundation"], ref: "ui" })
      ]
    });
    for (const [name, args] of INVALID_ARGUMENTS) {
      expect(() => validateArgs(toolByName(tools, name), args), name).toThrow(/Validation failed/);
    }

    for (const [name, method, args] of DELEGATED_CALLS) {
      await toolByName(tools, name).execute(`tool-${name}`, args as never, undefined, undefined, {} as never);
      expect(calls.at(-1), name).toEqual([method, args]);
    }
    expect(calls).toHaveLength(DELEGATED_CALLS.length);
  });

test("creates high-risk proposals without mutating issues or sessions", async () => {
    const fixture = await openFixture();
    const actions = createPiRunnerActions(fixture.db, { project: fixture.project });
    const tools = createPiRunnerActionTools(actions);
    const issueID = insertIssue(fixture.db, { projectID: fixture.project.id, status: "triage", title: "Queue me" });
    insertAgentSession(fixture.db, { projectID: fixture.project.id, role: "reviewer", sessionKey: "codex:thread-1" });
    insertAgentSession(fixture.db, { projectID: fixture.project.id, role: "reporter", sessionKey: "codex:thread-2" });

    const createIssue = await runTool(tools, "issue_create_proposal", {
      description: "New scoped issue",
      project_id: fixture.project.id,
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
  });

test("exposes destructive issue deletion and Runner administration only as high-risk proposals", async () => {
    const fixture = await openFixture();
    const issueID = insertIssue(fixture.db, {
      projectID: fixture.project.id,
      status: "triage",
      title: "Delete only after approval"
    });
    const actions = createPiRunnerActions(fixture.db, { project: fixture.project });

    const deletion = actions.deleteIssues({ issue_ids: [issueID], reason: "用户确认永久删除" }) as {
      action_id: string; status: string;
    };
    const settings = actions.updateRunnerSettings({
      max_parallel_projects: 2,
      reason: "用户要求修改并发"
    }) as { action_id: string; status: string };
    const restart = actions.restartSystem({ reason: "用户要求重启" }) as {
      action_id: string; status: string;
    };

    expect([deletion.status, settings.status, restart.status]).toEqual(["pending", "pending", "pending"]);
    expect(getIssue(fixture.db, issueID)).not.toBeNull();
    expect([deletion, settings, restart].map((item) => getPiAction(fixture.db, item.action_id)?.risk_level))
      .toEqual(["high", "high", "high"]);
    expect(actions.readRunnerSettings({})).toMatchObject({ max_parallel_projects: 1 });
  });

test("caps model-visible tool result content while preserving full details", async () => {
    const tools = createPiRunnerActionTools({
      ...fakeActions([]),
      listIssues: () => ({ items: [{ description: "x".repeat(20_000), id: 1, title: "Huge" }] })
    });

    const result = await runTool(tools, "issue_list", {});
    const text = collectToolText(result.content);

    expect(text.length).toBeLessThan(10_000);
    expect(text).toContain("[tool result truncated");
    expect(JSON.stringify(result.details)).toContain("x".repeat(20_000));
  });

test("global Runner project_status summarizes all projects without project_id", async () => {
    const fixture = await openFixture();
    const actions = createPiRunnerActions(fixture.db);

    expect(actions.projectStatus({})).toMatchObject({
      items: [{ id: fixture.project.id, name: fixture.project.name, status: "active" }]
    });
    expect(listPiActions(fixture.db, { status: "completed" })).toContainEqual(expect.objectContaining({
      action_type: "project.status",
      project_id: "",
      payload_json: "{}"
    }));
  });
}
