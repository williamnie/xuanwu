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

export function registerDelegatedAuthorizationDoesNotAutoExecute() {
test("delegated authorization does not auto-execute covered high-risk proposals", async () => {
    const fixture = await openFixture();
    try {
      insertAgentSession(fixture.db, { projectID: fixture.project.id, sessionKey: "codex:thread-1" });
      const result = createPiRunnerActions(fixture.db, {
        authorization: {
          authorizedActions: [{ action_type: "session.steer", project_id: fixture.project.id }],
          mode: "delegated",
          scope: { project_id: fixture.project.id }
        },
        project: fixture.project
      }).createSessionSteerProposal({
        prompt: "change running executor",
        session_key: "codex:thread-1"
      }) as { action_id: string; decision: string; status: string };
      const stored = getPiAction(fixture.db, result.action_id);

      expect(result).toMatchObject({ decision: "ask", status: "pending" });
      expect(stored).toMatchObject({
        action_type: "session.steer",
        gate_decision: "ask",
        risk_level: "high",
        status: "pending"
      });
      expect(listPiActionEvents(fixture.db, { actionId: result.action_id }).map((event) => event.event_type)).toEqual([
        "candidate",
        "gate_decision",
        "pending_approval"
      ]);
    } finally {
      await fixture.close();
    }
  });
}
