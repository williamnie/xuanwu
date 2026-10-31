import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { getIssue } from "../../db/repositories/issues.ts";
import { listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { createIssueRun } from "../../db/repositories/issueRuns.ts";
import { getPiAction, getPiIssueCompletionWatch, listPiActionEvents, listPiActions } from "../../db/repositories/pi.ts";
import { getProject, type Project } from "../../db/repositories/projects.ts";
import { createHumanReviewRequest } from "../../domain/review/humanReview.ts";
import { createPiRunnerActions } from "./runnerActions.ts";
import { useDatabaseCleanup } from "../../testing/harness.ts";

import { trackDatabase, openFixture, insertIssue, insertAgentSession } from "./runnerActionGateTestFixtures.ts";

export function registerDelegatedModeOnlyAutoExecutesActions() {
test("delegated mode only auto-executes actions covered by an authorization envelope", async () => {
    const fixture = await openFixture();
    try {
      const issueID = insertIssue(fixture.db, { projectID: fixture.project.id, status: "todo", title: "Delegated" });
      const denied = createPiRunnerActions(fixture.db, {
        authorization: {
          authorizedActions: [{ action_type: "issue.comment", issue_id: issueID + 1, project_id: fixture.project.id }],
          mode: "delegated",
          scope: { project_id: fixture.project.id }
        },
        project: fixture.project
      }).commentIssue({ issue_id: issueID, body: "not covered" }) as { action_id: string; decision: string; status: string };
      const allowed = createPiRunnerActions(fixture.db, {
        authorization: {
          authorizedActions: [{ action_type: "issue.comment", issue_id: issueID, project_id: fixture.project.id }],
          mode: "delegated",
          scope: { project_id: fixture.project.id }
        },
        project: fixture.project
      }).commentIssue({ issue_id: issueID, body: "covered" }) as { action_id: string; decision: string; status: string };
      const allowedAction = listPiActions(fixture.db).find((action) => action.gate_decision === "execute");

      expect(denied).toMatchObject({ decision: "deny", status: "denied" });
      expect(allowed).toMatchObject({ type: "issue.comment", issue_id: issueID });
      expect(allowedAction).toMatchObject({
        action_type: "issue.comment",
        gate_decision: "execute",
        status: "completed"
      });
      expect(listIssueEvents(fixture.db, issueID).map((event) => event.payload)).toEqual([
        expect.stringContaining("covered")
      ]);
      expect(listPiActionEvents(fixture.db, { actionId: denied.action_id }).map((event) => event.event_type)).toEqual([
        "candidate",
        "gate_decision"
      ]);
    } finally {
      await fixture.close();
    }
  });

test("delegated authorization auto-executes covered confirm action proposals", async () => {
    const fixture = await openFixture();
    try {
      const issueID = insertIssue(fixture.db, { projectID: fixture.project.id, status: "triage", title: "Ready" });
      const actions = createPiRunnerActions(fixture.db, {
        authorization: {
          authorizedActions: [{ action_type: "issue.enqueue", issue_id: issueID, project_id: fixture.project.id }],
          mode: "delegated",
          scope: { project_id: fixture.project.id }
        },
        project: fixture.project
      });
      const result = actions.enqueueIssueProposal({ issue_id: issueID, rationale: "delegated ready" }) as {
        action_id: string; decision: string; status: string;
      };
      const stored = getPiAction(fixture.db, result.action_id);

      expect(result).toMatchObject({ decision: "execute", status: "completed" });
      expect(stored).toMatchObject({
        action_type: "issue.enqueue",
        gate_decision: "execute",
        status: "completed"
      });
      expect(getIssue(fixture.db, issueID)).toMatchObject({ status: "todo" });
      expect(listPiActionEvents(fixture.db, { actionId: result.action_id }).map((event) => event.event_type)).toEqual([
        "candidate",
        "gate_decision",
        "execution_started",
        "execution_result"
      ]);
    } finally {
      await fixture.close();
    }
  });

test("notifies runtime when delegated enqueue should start an executor session", async () => {
    const fixture = await openFixture();
    const kicked: string[] = [];
    try {
      const issueID = insertIssue(fixture.db, { projectID: fixture.project.id, status: "triage", title: "Run from Feishu" });
      const actions = createPiRunnerActions(fixture.db, {
        authorization: {
          authorizedActions: [{ action_type: "issue.enqueue", issue_id: issueID, project_id: fixture.project.id }],
          mode: "delegated",
          scope: { project_id: fixture.project.id }
        },
        onIssueEnqueued: (projectID: string) => kicked.push(projectID),
        project: fixture.project
      });

      const result = actions.enqueueIssueProposal({ issue_id: issueID, rationale: "default run from Feishu" }) as {
        action_id: string; decision: string; status: string;
      };

      expect(result).toMatchObject({ decision: "execute", status: "completed" });
      expect(getIssue(fixture.db, issueID)).toMatchObject({ status: "todo" });
      expect(kicked).toEqual([fixture.project.id]);
    } finally {
      await fixture.close();
    }
  });

test("Runner Chat source scopes enqueue from explicit issue id without a conversation project", async () => {
    const fixture = await openFixture();
    const kicked: string[] = [];
    try {
      const issueID = insertIssue(fixture.db, { projectID: fixture.project.id, status: "triage", title: "Start by id" });
      const actions = createPiRunnerActions(fixture.db, {
        onIssueEnqueued: (projectID: string) => kicked.push(projectID),
        source: "feishu_runner_chat"
      });

      const result = actions.enqueueIssueProposal({ issue_id: issueID, rationale: "开始明确 issue" }) as {
        action_id: string; decision: string; status: string;
      };

      expect(result).toMatchObject({ decision: "execute", status: "completed" });
      expect(getPiAction(fixture.db, result.action_id)).toMatchObject({
        action_type: "issue.enqueue",
        gate_decision: "execute",
        project_id: fixture.project.id,
        status: "completed"
      });
      expect(getIssue(fixture.db, issueID)).toMatchObject({ status: "todo" });
      expect(kicked).toEqual([fixture.project.id]);
    } finally {
      await fixture.close();
    }
  });

test("global Runner Chat authorizes an explicit Issue without a project scope", async () => {
    const fixture = await openFixture();
    const kicked: string[] = [];
    try {
      const issueID = insertIssue(fixture.db, {
        projectID: fixture.project.id,
        status: "triage",
        title: "Start from unbound chat"
      });
      const actions = createPiRunnerActions(fixture.db, {
        authorization: {
          allowedActions: ["issue.read", "issue.enqueue"],
          askOnMissingAuthorization: true,
          authorizedActions: [{ action_type: "issue.read" }],
          mode: "delegated",
          scopes: [{ runner_resource: "issues" }]
        },
        onIssueEnqueued: (projectID: string) => kicked.push(projectID),
        source: "feishu_runner_chat"
      });

      const result = actions.enqueueIssueProposal({
        issue_id: issueID,
        rationale: "用户明确要求开始这个 Issue"
      }) as { action_id: string; decision: string; status: string };

      expect(result).toMatchObject({ decision: "execute", status: "completed" });
      expect(getPiAction(fixture.db, result.action_id)).toMatchObject({
        action_type: "issue.enqueue",
        gate_decision: "execute",
        gate_reason: expect.stringContaining("scope matched runner issues"),
        issue_id: issueID,
        project_id: fixture.project.id,
        status: "completed"
      });
      expect(getIssue(fixture.db, issueID)).toMatchObject({ status: "todo" });
      expect(kicked).toEqual([fixture.project.id]);
    } finally {
      await fixture.close();
    }
  });
}
