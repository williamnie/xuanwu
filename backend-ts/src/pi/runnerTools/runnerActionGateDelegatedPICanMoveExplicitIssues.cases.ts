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

export function registerDelegatedPICanMoveExplicitIssues() {
test("delegated PI can move explicit issues through the shared status contract", async () => {
    const fixture = await openFixture();
    const kicked: string[] = [];
    try {
      const first = insertIssue(fixture.db, {
        projectID: fixture.project.id,
        status: "triage",
        title: "Move first"
      });
      const second = insertIssue(fixture.db, {
        projectID: fixture.project.id,
        status: "triage",
        title: "Move second"
      });
      const actions = createPiRunnerActions(fixture.db, {
        authorization: {
          allowedActions: ["issue.status_update"],
          authorizedActions: [{ action_type: "issue.status_update", project_id: fixture.project.id }],
          mode: "delegated",
          scope: { project_id: fixture.project.id }
        },
        onIssueEnqueued: (projectID: string) => kicked.push(projectID),
        project: fixture.project
      });

      const moved = await actions.updateIssueStatuses({
        issue_ids: [first, second],
        reason: "用户要求放入待办",
        status: "todo"
      }) as { action_id: string; result: { accepted: number; items: Array<Record<string, unknown>> }; status: string };
      const detail = actions.readIssue({ id: first }) as {
        allowed_status_targets: string[];
        dependency: { ready: boolean; reason: string };
        execution: { issue: { id: number; status: string } };
        status: string;
      };

      expect(moved).toMatchObject({
        result: {
          accepted: 2,
          items: [
            { actual_status: "todo", reached_target: true, requested_status: "todo" },
            { actual_status: "todo", reached_target: true, requested_status: "todo" }
          ],
          requested_status: "todo",
          status: "completed"
        },
        status: "completed"
      });
      expect(getPiAction(fixture.db, moved.action_id)).toMatchObject({
        action_type: "issue.status_update",
        gate_decision: "execute",
        status: "completed"
      });
      expect(detail).toMatchObject({
        allowed_status_targets: ["triage", "in_progress", "cancelled"],
        dependency: { ready: true, reason: "ready" },
        execution: { issue: { id: first, status: "todo" } },
        status: "todo"
      });
      expect(kicked).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

test("PI rejects invalid terminal status moves before mutating any issue", async () => {
    const fixture = await openFixture();
    try {
      const done = insertIssue(fixture.db, {
        projectID: fixture.project.id,
        status: "done",
        title: "Already done"
      });
      const triage = insertIssue(fixture.db, {
        projectID: fixture.project.id,
        status: "triage",
        title: "Must remain triage"
      });
      const actions = createPiRunnerActions(fixture.db, {
        source: "feishu_runner_chat"
      });

      expect(() => actions.updateIssueStatuses({
        issue_ids: [done, triage],
        reason: "错误的批量移动",
        status: "todo"
      })).toThrow(/Issue #.*不允许从 done 移动到 todo/);
      expect(getIssue(fixture.db, done)?.status).toBe("done");
      expect(getIssue(fixture.db, triage)?.status).toBe("triage");
    } finally {
      await fixture.close();
    }
  });

test("completion watch create/cancel follow delegated, attended, and read-only gate semantics", async () => {
    const fixture = await openFixture();
    try {
      const issueID = insertIssue(fixture.db, { projectID: fixture.project.id, status: "todo", title: "Watch me" });
      const attended = createPiRunnerActions(fixture.db, { project: fixture.project })
        .createIssueCompletionWatch({ issue_ids: [issueID], target_channel: "feishu" }) as {
          action_id: string; decision: string; status: string;
        };

      expect(attended).toMatchObject({ decision: "ask", status: "pending" });
      expect(listPiActions(fixture.db, { status: "pending" })).toContainEqual(expect.objectContaining({
        action_type: "issue_completion_watch.create",
        risk_level: "medium"
      }));

      const delegated = createPiRunnerActions(fixture.db, {
        source: "feishu_runner_chat"
      }).createIssueCompletionWatch({
        issue_ids: [issueID],
        source_event_id: "event-1",
        target_channel: "feishu_runner_chat",
        target_chat_id: "oc_group"
      }) as {
        result?: { watch_id?: string };
        status: string;
      };
      const watchID = delegated.result?.watch_id ?? "";

      expect(delegated).toMatchObject({
        decision: "execute",
        result: {
          already_satisfied: false,
          target_channel: "feishu",
          watched_issues: [{ id: issueID, title: "Watch me" }]
        },
        status: "completed"
      });
      expect(getPiIssueCompletionWatch(fixture.db, watchID)).toMatchObject({
        status: "active",
        target_chat_id: "oc_group",
        items: [expect.objectContaining({ issue_id: issueID })]
      });

      const trustedTarget = createPiRunnerActions(fixture.db, {
        notificationTarget: { connectorID: "telegram", conversationID: "tg_trusted" },
        source: "telegram_runner_chat"
      }).createIssueCompletionWatch({
        issue_ids: [issueID],
        source_event_id: "event-2",
        target_channel: "feishu_runner_chat",
        target_chat_id: "oc_untrusted"
      }) as { result?: { watch_id?: string }; status: string };
      expect(getPiIssueCompletionWatch(fixture.db, trustedTarget.result?.watch_id ?? "")).toMatchObject({
        status: "active",
        target_channel: "telegram",
        target_chat_id: "tg_trusted"
      });

      const readOnly = createPiRunnerActions(fixture.db, {
        authorization: {
          allowed_actions: ["issue.enqueue"],
          authorizedActions: [{ action_type: "issue.enqueue", issue_id: issueID, project_id: fixture.project.id }],
          mode: "delegated",
          scope: { project_id: fixture.project.id }
        },
        project: fixture.project
      }).listIssueCompletionWatches({ project_id: fixture.project.id }) as { status?: string; items?: unknown[] };

      expect(readOnly).toMatchObject({
        count: 2,
        items: expect.arrayContaining([
          expect.objectContaining({ watch_id: watchID }),
          expect.objectContaining({ target_channel: "telegram" })
        ])
      });
      expect(readOnly.status).toBeUndefined();

      const cancelled = createPiRunnerActions(fixture.db, {
        source: "feishu_runner_chat"
      }).cancelIssueCompletionWatch({ reason: "user_cancel", watch_id: watchID }) as {
        result?: { current_status?: string; watch_id?: string };
        status: string;
      };

      expect(cancelled).toMatchObject({
        decision: "execute",
        result: { current_status: "cancelled", watch_id: watchID },
        status: "completed"
      });
      expect(getPiIssueCompletionWatch(fixture.db, watchID)).toMatchObject({
        error: "user_cancel",
        status: "cancelled"
      });
      expect(() => createPiRunnerActions(fixture.db, { project: fixture.project })
        .createIssueCompletionWatch({ issue_ids: [], project_id: fixture.project.id }))
        .toThrow("issue_ids is required");
    } finally {
      await fixture.close();
    }
  });
}
