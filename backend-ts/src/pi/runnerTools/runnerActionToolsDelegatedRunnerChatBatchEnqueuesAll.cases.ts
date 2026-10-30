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

export function registerDelegatedRunnerChatBatchEnqueuesAll() {
test("delegated runner chat batch-enqueues all matching triage issues for the current project", async () => {
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
    const selectedA = insertIssue(fixture.db, {
      createdAt: "2026-01-01T00:00:00Z",
      priority: 10,
      projectID: fixture.project.id,
      status: "triage",
      title: "First selected"
    });
    const selectedB = insertIssue(fixture.db, {
      createdAt: "2026-01-02T00:00:00Z",
      priority: 10,
      projectID: fixture.project.id,
      status: "triage",
      title: "Second selected"
    });
    const skippedByLimit = insertIssue(fixture.db, {
      createdAt: "2026-01-03T00:00:00Z",
      priority: 10,
      projectID: fixture.project.id,
      status: "triage",
      title: "Skipped by limit"
    });
    insertIssue(fixture.db, {
      createdAt: "2026-01-01T00:00:00Z",
      priority: 20,
      projectID: fixture.project.id,
      status: "todo",
      title: "Already todo"
    });
    const actions = createPiRunnerActions(fixture.db, {
      onIssueEnqueued: (projectID) => kickedProjects.push(projectID),
      project: fixture.project,
      source: "runner_chat"
    });

    const result = actions.enqueueBatchTriageIssues({
      rationale: "开始这25个issue",
      user_phrase: "开始这25个issue"
    }) as {
      enqueued_count: number;
      enqueued: Array<{ id: number; status: string; title: string }>;
      skipped: Array<{ count: number; reason: string }>;
      status: string;
    };

    expect(result).toMatchObject({
      enqueued_count: 3,
      enqueued: [
        { id: selectedA, status: "todo", title: "First selected" },
        { id: selectedB, status: "todo", title: "Second selected" },
        { id: skippedByLimit, status: "todo", title: "Skipped by limit" }
      ],
      project_id: fixture.project.id,
      skipped: [],
      status: "completed"
    });
    expect(getIssue(fixture.db, selectedA)).toMatchObject({ status: "todo" });
    expect(getIssue(fixture.db, selectedB)).toMatchObject({ status: "todo" });
    expect(getIssue(fixture.db, skippedByLimit)).toMatchObject({ status: "todo" });
    expect(getIssue(fixture.db, otherProjectIssue)).toMatchObject({ status: "triage" });
    expect(kickedProjects).toEqual([fixture.project.id]);
    expect(listPiActions(fixture.db, { status: "completed" }).filter((action) => action.action_type === "issue.enqueue"))
      .toHaveLength(3);
    expect(listPiActions(fixture.db, { status: "completed" })).toContainEqual(expect.objectContaining({
      action_type: "issue.enqueue",
      issue_id: selectedA
    }));
    expect(listPiActions(fixture.db, { status: "completed" })).toContainEqual(expect.objectContaining({
      action_type: "issue.enqueue",
      issue_id: selectedB
    }));
    const payloads = listPiActions(fixture.db, { status: "completed" })
      .filter((action) => action.action_type === "issue.enqueue")
      .map((action) => JSON.parse(action.payload_json));
    const runGroupIDs = new Set(payloads.map((payload) => payload.run_group_id));
    expect(runGroupIDs.size).toBe(1);
    expect(payloads).toContainEqual(expect.objectContaining({ issue_id: selectedA, run_group_id: expect.any(String) }));
    expect(payloads).toContainEqual(expect.objectContaining({ issue_id: selectedB, run_group_id: expect.any(String) }));
  });

test("batch triage enqueue keeps ordinary chat behind approval gate without a count cap", async () => {
    const fixture = await openFixture();
    const kickedProjects: string[] = [];
    const issueIDs = Array.from({ length: 6 }, (_unused, index) => insertIssue(fixture.db, {
      createdAt: `2026-01-0${index + 1}T00:00:00Z`,
      priority: 1,
      projectID: fixture.project.id,
      status: "triage",
      title: `Candidate ${index + 1}`
    }));
    const actions = createPiRunnerActions(fixture.db, {
      onIssueEnqueued: (projectID) => kickedProjects.push(projectID),
      project: fixture.project
    });

    const result = actions.enqueueBatchTriageIssues({
      rationale: "完成所有 issue",
      user_phrase: "完成所有 issue"
    }) as {
      enqueued_count: number;
      pending_count: number;
      skipped: Array<{ count: number; reason: string }>;
      status: string;
    };

    expect(result).toMatchObject({
      enqueued_count: 0,
      pending_count: 6,
      skipped: [
        { count: 6, reason: "risk requires user confirmation" }
      ],
      status: "pending"
    });
    expect(issueIDs.map((id) => getIssue(fixture.db, id)?.status)).toEqual([
      "triage", "triage", "triage", "triage", "triage", "triage"
    ]);
    expect(kickedProjects).toEqual([]);
    expect(listPiActions(fixture.db, { status: "pending" })
      .filter((action) => action.action_type === "issue.enqueue")).toHaveLength(6);
  });

test("batch triage enqueue trusts agent intent instead of re-parsing ambiguous phrases", async () => {
    const fixture = await openFixture();
    const issueID = insertIssue(fixture.db, { projectID: fixture.project.id, status: "triage", title: "Should stay triage" });
    const actions = createPiRunnerActions(fixture.db, {
      project: fixture.project,
      source: "runner_chat"
    });

    const result = actions.enqueueBatchTriageIssues({ user_phrase: "开始做吧" }) as {
      enqueued_count: number;
      status: string;
    };

    expect(result).toMatchObject({
      enqueued_count: 1,
      status: "completed"
    });
    expect(getIssue(fixture.db, issueID)).toMatchObject({ status: "todo" });
    expect(listPiActions(fixture.db, { status: "completed" })).toHaveLength(1);
  });

test("next triage enqueue reports no candidate without mutating issues", async () => {
    const fixture = await openFixture();
    insertIssue(fixture.db, { projectID: fixture.project.id, status: "done", title: "Already done" });
    const actions = createPiRunnerActions(fixture.db, { project: fixture.project });

    const result = actions.enqueueNextTriageIssue({}) as {
      message: string;
      project_id: string;
      source: string;
      status: string;
    };

    expect(result).toEqual({
      message: "没有可继续的 triage issue",
      project_id: fixture.project.id,
      source: "issue_enqueue_next_triage",
      status: "no_candidate"
    });
    expect(listIssues(fixture.db, { projectId: fixture.project.id, status: "todo" })).toHaveLength(0);
    expect(listPiActions(fixture.db)).toHaveLength(0);
  });
}
