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

export function registerAllIMRunnerChatSourcesAuthorize() {
test("all IM Runner Chat sources authorize an exact human-review Issue without a conversation Project", async () => {
    const fixture = await openFixture();
    try {
      for (const source of ["runner_chat", "feishu_runner_chat", "telegram_runner_chat", "matrix_runner_chat"]) {
        const issueID = insertIssue(fixture.db, {
          projectID: fixture.project.id,
          status: "needs_user",
          title: `Human review from ${source}`
        });
        const run = createIssueRun(fixture.db, issueID);
        fixture.db.sqlite.run("update issue_runs set status='succeeded', ended_at=? where id=?", [
          "2026-08-01T00:00:00Z", run.id
        ]);
        const request = createHumanReviewRequest(fixture.db, issueID, {
          question: "是否接受当前交付并推迟外部验收？"
        });
        const actions = createPiRunnerActions(fixture.db, {
          authorization: {
            allowedActions: ["human_review.respond"],
            askOnMissingAuthorization: true,
            authorizedActions: [],
            mode: "delegated",
            scopes: [
              { runner_resource: "agent_catalog" },
              { runner_resource: "issues" }
            ]
          },
          project: undefined,
          source
        });

        const result = await actions.respondToHumanReview({
          action: "accept",
          comment: "接受当前交付，外部验收后续补充。",
          issue_id: issueID,
          review_request_id: request.id,
          review_revision: request.revision
        }) as { action_id: string; decision: string; status: string };

        expect(result).toMatchObject({ decision: "execute", status: "completed" });
        expect(getPiAction(fixture.db, result.action_id)).toMatchObject({
          action_type: "human_review.respond",
          gate_decision: "execute",
          gate_reason: expect.stringContaining("scope matched runner issues"),
          issue_id: issueID,
          project_id: fixture.project.id,
          status: "completed"
        });
      }
    } finally {
      await fixture.close();
    }
  });

test("global Runner Chat authorizes an explicit Issue batch without a project scope", async () => {
    const fixture = await openFixture();
    try {
      const issueIDs = ["First", "Second"].map((title) => insertIssue(fixture.db, {
        projectID: fixture.project.id,
        status: "triage",
        title
      }));
      const actions = createPiRunnerActions(fixture.db, {
        authorization: {
          allowedActions: ["issue.read", "issue.cancel"],
          askOnMissingAuthorization: true,
          authorizedActions: [{ action_type: "issue.read" }],
          mode: "delegated",
          scopes: [{ runner_resource: "issues" }]
        },
        source: "feishu_runner_chat"
      });

      const result = await actions.cancelIssues({
        issue_ids: issueIDs,
        rationale: "用户明确取消这些 Issue"
      }) as { action_id: string; decision: string; status: string };

      expect(result).toMatchObject({ decision: "execute", status: "completed" });
      expect(getPiAction(fixture.db, result.action_id)).toMatchObject({
        action_type: "issue.cancel",
        gate_decision: "execute",
        gate_reason: expect.stringContaining("scope matched runner issues"),
        status: "completed"
      });
      expect(issueIDs.map((id) => getIssue(fixture.db, id)?.status)).toEqual(["cancelled", "cancelled"]);
    } finally {
      await fixture.close();
    }
  });

test("unbound Runner Chat still asks before an explicit high-risk mutation", async () => {
    const fixture = await openFixture();
    try {
      const issueID = insertIssue(fixture.db, {
        projectID: fixture.project.id,
        status: "triage",
        title: "Do not delete without approval"
      });
      const actions = createPiRunnerActions(fixture.db, {
        authorization: {
          allowedActions: ["issue.read", "issue.delete"],
          askOnMissingAuthorization: true,
          authorizedActions: [{ action_type: "issue.read" }],
          mode: "delegated",
          scopes: [{ runner_resource: "issues" }]
        },
        source: "feishu_runner_chat"
      });

      const result = actions.deleteIssues({
        issue_ids: [issueID],
        reason: "用户明确要求删除"
      }) as { action_id: string; decision: string; status: string };

      expect(result).toMatchObject({ decision: "ask", status: "pending" });
      expect(getPiAction(fixture.db, result.action_id)).toMatchObject({
        action_type: "issue.delete",
        gate_decision: "ask",
        risk_level: "high",
        status: "pending"
      });
      expect(getIssue(fixture.db, issueID)).not.toBeNull();
    } finally {
      await fixture.close();
    }
  });

test("Runner Chat directly cancels an explicit batch of triage issues", async () => {
    const fixture = await openFixture();
    const kicked: string[] = [];
    try {
      const issueIDs = ["A", "B", "C"].map((title) => insertIssue(fixture.db, {
        projectID: fixture.project.id,
        status: "triage",
        title: `Cancel ${title}`
      }));
      const actions = createPiRunnerActions(fixture.db, {
        onIssueEnqueued: (projectID: string) => kicked.push(projectID),
        source: "feishu_runner_chat"
      });

      const result = await actions.cancelIssues({ issue_ids: issueIDs, rationale: "用户明确说不做了" }) as {
        action_id: string; decision: string; result: { accepted: number; requested_status: string }; status: string;
      };

      expect(result).toMatchObject({
        decision: "execute",
        result: { accepted: 3, requested_status: "cancelled", status: "completed" },
        status: "completed"
      });
      expect(getPiAction(fixture.db, result.action_id)).toMatchObject({
        action_type: "issue.cancel",
        gate_decision: "execute",
        project_id: fixture.project.id,
        status: "completed"
      });
      expect(issueIDs.map((id) => getIssue(fixture.db, id)?.status)).toEqual([
        "cancelled", "cancelled", "cancelled"
      ]);
      expect(kicked).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
}
