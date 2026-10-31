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

export function registerKeepsConfirmRequiredActionsPendingAnd() {
test("keeps confirm-required actions pending and records rationale/result", async () => {
    const fixture = await openFixture();
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
      project_id: fixture.project.id,
      rationale: "ready to run",
      requires_confirmation: 1,
      result_json: expect.stringContaining("pending"),
      risk_level: "medium",
      status: "pending"
    });
    expect(JSON.parse(stored?.payload_json ?? "{}")).toMatchObject({
      expected_state: {
        issue_id: issueID,
        project_id: fixture.project.id,
        status: "triage"
      },
      issue_id: issueID
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
  });

test("delegated runner chat can schedule one issue enqueue through a real once cron", async () => {
    const fixture = await openFixture();
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
    const automation = listAutomations(fixture.db).find((item) => item.id.startsWith("automation:issue-"));

    expect(result).toMatchObject({ decision: "execute", status: "completed" });
    expect(getPiAction(fixture.db, result.action_id)).toMatchObject({
      action_type: "issue.schedule_enqueue",
      conversation_id: "conv-chat",
      gate_decision: "execute",
      issue_id: issueID,
      status: "completed"
    });
    expect(automation).toMatchObject({
      mode: "execute_allowed",
      next_run_at: "2999-01-01T00:00:00.000Z",
      owner: { kind: "project", project_id: fixture.project.id },
      status: "active"
    });
    expect(automation?.workflow_ref).toBe("workflow:implement@1");
    expect(getIssue(fixture.db, issueID)?.status).toBe("triage");
  });

test("delegated runner chat issue creation returns the created issue id", async () => {
    const fixture = await openFixture();
    const actions = createPiRunnerActions(fixture.db, {
      authorization: {
        authorizedActions: [{ action_type: "issue.create", project_id: fixture.project.id }],
        mode: "delegated",
        scope: { project_id: fixture.project.id }
      },
      conversationID: "conv-chat",
      project: fixture.project
    });

    expect(() => actions.createIssueProposal({
      description: "Do not inherit the conversation project",
      title: "Missing explicit project"
    })).toThrow("issue_create_project_required: 创建 Issue 需要 project_id，但当前工具输入未提供目标 Project 信息");

    const result = actions.createIssueProposal({
      description: "Create and then ask when to run",
      project_id: fixture.project.id,
      title: "Chat-created issue"
    }) as { result?: { id?: number }; status: string };

    expect(result).toMatchObject({
      decision: "execute",
      result: { id: 1, status: "triage", title: "Chat-created issue" },
      status: "completed"
    });
    expect(getIssue(fixture.db, 1)).toMatchObject({ title: "Chat-created issue" });
  });

test("delegated runner chat enqueues exactly one next triage issue for the current project", async () => {
    const fixture = await openFixture();
    const kickedProjects: string[] = [];
    insertProject(fixture.db, "other", { name: "Other", sort_order: 2 });
    const otherProjectIssue = insertIssue(fixture.db, {
      createdAt: "2026-01-01T00:00:00Z",
      priority: 99,
      projectID: "other",
      status: "triage",
      title: "Other project should not run"
    });
    insertIssue(fixture.db, {
      createdAt: "2026-01-03T00:00:00Z",
      priority: 10,
      projectID: fixture.project.id,
      status: "triage",
      title: "High but later"
    });
    const selected = insertIssue(fixture.db, {
      createdAt: "2026-01-02T00:00:00Z",
      priority: 10,
      projectID: fixture.project.id,
      status: "triage",
      title: "Selected next"
    });
    const tiedLaterID = insertIssue(fixture.db, {
      createdAt: "2026-01-02T00:00:00Z",
      priority: 10,
      projectID: fixture.project.id,
      status: "triage",
      title: "Same rank later id"
    });
    insertIssue(fixture.db, {
      createdAt: "2026-01-01T00:00:00Z",
      priority: 1,
      projectID: fixture.project.id,
      status: "triage",
      title: "Low priority first created"
    });
    const actions = createPiRunnerActions(fixture.db, {
      onIssueEnqueued: (projectID) => kickedProjects.push(projectID),
      project: fixture.project,
      source: "runner_chat"
    });

    const result = actions.enqueueNextTriageIssue({ rationale: "继续做下一个" }) as {
      decision: string;
      issue_id: number;
      result?: { id?: number; status?: string; title?: string };
      status: string;
    };

    expect(result).toMatchObject({
      decision: "execute",
      issue_id: selected,
      result: { id: selected, status: "todo", title: "Selected next" },
      status: "completed"
    });
    expect(getIssue(fixture.db, selected)).toMatchObject({ status: "todo" });
    expect(getIssue(fixture.db, tiedLaterID)).toMatchObject({ status: "triage" });
    expect(getIssue(fixture.db, otherProjectIssue)).toMatchObject({ status: "triage" });
    expect(listIssues(fixture.db, { projectId: fixture.project.id, status: "todo" })).toHaveLength(1);
    expect(listIssues(fixture.db, { projectId: fixture.project.id, status: "triage" })).toHaveLength(3);
    expect(listIssues(fixture.db, { projectId: "other", status: "todo" })).toHaveLength(0);
    expect(kickedProjects).toEqual([fixture.project.id]);
    expect(listPiActions(fixture.db, { status: "completed" })).toContainEqual(expect.objectContaining({
      action_type: "issue.enqueue",
      issue_id: selected,
      payload_json: JSON.stringify({ issue_id: selected })
    }));
  });
}
