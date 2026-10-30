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

export function registerExecutesSafeReadsAndLowRisk() {
test("executes safe reads and low-risk comments through the action layer", async () => {
    const fixture = await openFixture();
    const actions = createPiRunnerActions(fixture.db, { project: fixture.project });
    const issueID = insertIssue(fixture.db, { projectID: fixture.project.id, status: "todo", title: "Read me" });
    insertAgentSession(fixture.db, { projectID: fixture.project.id, role: "reviewer", sessionKey: "codex:thread-1" });
    insertAgentSession(fixture.db, { projectID: fixture.project.id, role: "reporter", sessionKey: "codex:thread-2" });

    expect(actions.listIssues({ status: "todo" })).toMatchObject({ items: [{ id: issueID, title: "Read me" }] });
    expect(actions.readIssue({ id: issueID })).toMatchObject({ id: issueID, title: "Read me" });
    expect(projectIDs(actions.listProjects({}))).toContain(fixture.project.id);
    expect(sessionKeys(actions.listSessions({ role: "reviewer" }))).toEqual(["codex:thread-1"]);
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
  });

test("accepts an open human review without creating a retry Run or Provider Session", async () => {
    const fixture = await openFixture();
    const issueID = insertIssue(fixture.db, {
      projectID: fixture.project.id,
      status: "needs_user",
      title: "Completed implementation awaiting smoke decision"
    });
    const run = createIssueRun(fixture.db, issueID);
    fixture.db.sqlite.run(
      "update issue_runs set status='succeeded', ended_at=? where id=?",
      ["2026-08-01T00:00:00Z", run.id]
    );
    const request = createHumanReviewRequest(fixture.db, issueID, {
      question: "是否接受离线实现，并由用户后续手动执行真实 smoke？"
    });
    const actions = createPiRunnerActions(fixture.db, {
      project: fixture.project,
      source: "runner_chat"
    });

    await actions.respondToHumanReview({
      action: "accept",
      comment: "接受当前离线实现；真实 smoke 后续手动执行。",
      issue_id: issueID,
      review_request_id: request.id,
      review_revision: request.revision
    });

    expect(getIssue(fixture.db, issueID)?.status).toBe("in_progress");
    expect(listIssueRuns(fixture.db, issueID)).toHaveLength(1);
    expect(readIssueDecisionProjection(fixture.db, issueID)).toMatchObject({
      owner: "pi",
      phase: "pi_queued",
      request: { id: request.id, status: "accepted" }
    });
    expect(listPiActions(fixture.db, { status: "completed" })).toContainEqual(expect.objectContaining({
      action_type: "human_review.respond",
      issue_id: issueID
    }));
  });

test("returns compact issue list and status summary without full issue details", async () => {
    const fixture = await openFixture();
    const actions = createPiRunnerActions(fixture.db, { project: fixture.project });
    insertIssue(fixture.db, {
      description: "large detail TOKEN=secret " + "x".repeat(2000),
      projectID: fixture.project.id,
      status: "todo",
      title: "First todo"
    });
    insertIssue(fixture.db, { projectID: fixture.project.id, status: "todo", title: "Second todo" });
    insertIssue(fixture.db, { projectID: fixture.project.id, status: "done", title: "Done item" });

    const list = actions.listIssues({}) as {
      items: Array<Record<string, unknown>>;
      limit: number;
      status_counts: Record<string, number>;
      total: number;
      truncated: boolean;
    };
    const summary = actions.issueStatusSummary({}) as {
      status_counts: Record<string, number>;
      total: number;
      unfinished_total: number;
    };

    expect(list).toMatchObject({
      limit: 50,
      status_counts: { done: 1, todo: 2 },
      total: 3,
      truncated: false
    });
    expect(list.items).toHaveLength(3);
    expect(list.items).toContainEqual(expect.objectContaining({ id: 1, status: "todo", title: "First todo" }));
    expect(JSON.stringify(list)).not.toContain("description");
    expect(JSON.stringify(list)).not.toContain("TOKEN=secret");
    expect(summary).toMatchObject({
      status_counts: { done: 1, todo: 2 },
      total: 3,
      unfinished_total: 2
    });
    expect(JSON.stringify(summary)).not.toContain("First todo");

    const limited = actions.listIssues({ limit: 1 }) as { items: unknown[]; limit: number; truncated: boolean };
    expect(limited).toMatchObject({ limit: 1, truncated: true });
    expect(limited.items).toHaveLength(1);
  });

test("uses an explicit global or project scope for issue counts", async () => {
    const fixture = await openFixture();
    insertProject(fixture.db, "other", { name: "Other", sort_order: 2 });
    insertIssue(fixture.db, { projectID: fixture.project.id, status: "todo", title: "Demo todo" });
    insertIssue(fixture.db, { projectID: fixture.project.id, status: "done", title: "Demo done" });
    insertIssue(fixture.db, { projectID: "other", status: "triage", title: "Other triage" });
    insertIssue(fixture.db, { projectID: "other", status: "failed", title: "Other failed" });
    const actions = createPiRunnerActions(fixture.db, {
      issueQueryDefaultScope: "global",
      project: fixture.project
    });

    expect(actions.issueStatusSummary({})).toMatchObject({
      scope: { kind: "global", project_id: "", source: "runtime_default" },
      status_counts: { done: 1, failed: 1, todo: 1, triage: 1 },
      terminal_status_counts: { done: 1, failed: 1 },
      total: 4,
      unfinished_status_counts: { failed: 1, todo: 1, triage: 1 },
      unfinished_total: 3
    });
    expect(actions.issueStatusSummary({ project_id: "demo", scope: "project" })).toMatchObject({
      scope: { kind: "project", project_id: "demo", source: "explicit_scope" },
      status_counts: { done: 1, todo: 1 },
      total: 2,
      unfinished_total: 1
    });
    expect(actions.listIssues({ scope: "global", status: "triage" })).toMatchObject({
      scope: { kind: "global", project_id: "", source: "explicit_scope" },
      total: 1
    });
    expect(() => actions.issueStatusSummary({ project_id: "demo", scope: "global" }))
      .toThrow("project_id must be empty when scope is global");
  });
}
