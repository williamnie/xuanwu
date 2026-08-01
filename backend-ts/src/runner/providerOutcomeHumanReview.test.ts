import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { createIssueRun } from "../db/repositories/issueRuns.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { createHumanReviewRequest, readIssueDecisionProjection } from "../domain/review/humanReview.ts";
import { reconcileProviderOutcome } from "./providerOutcome.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("provider outcome human review reconciliation", () => {
  test("returns an interrupted mistaken retry to the still-open human review instead of ghost in_progress", async () => {
    const db = await fixture();
    try {
      const issue = createIssue(db, {
        project_id: "demo",
        status: "needs_user",
        title: "Original implementation awaiting acceptance"
      });
      const originalRun = createIssueRun(db, issue.id);
      db.sqlite.run(
        "update issue_runs set status='succeeded', ended_at=? where id=?",
        ["2026-08-01T11:42:06Z", originalRun.id]
      );
      const request = createHumanReviewRequest(db, issue.id, {
        question: "是否接受原实现？"
      });
      updateIssue(db, issue.id, { status: "in_progress" });
      const mistakenRun = createIssueRun(db, issue.id);

      const reconciled = await reconcileProviderOutcome({
        database: db,
        issueID: issue.id,
        issueRunID: mistakenRun.id,
        providerID: "codex",
        reportedOutcome: { outcome: "failed", reason: "missing turn payload" }
      });

      expect(reconciled).toMatchObject({ status: "needs_user" });
      expect(getIssue(db, issue.id)).toMatchObject({ status: "needs_user" });
      expect(listIssueRuns(db, issue.id).at(-1)).toMatchObject({
        error: "missing turn payload",
        exit_reason: "provider_reported_failed",
        status: "failed"
      });
      expect(readIssueDecisionProjection(db, issue.id)).toMatchObject({
        owner: "human",
        request: { id: request.id, status: "open" }
      });
      expect(listIssueEvents(db, issue.id, {
        types: ["issue.pi_acceptance_requested.v1", "issue.human_review_restored.v1"]
      }).map((event) => event.type)).toEqual([
        "issue.pi_acceptance_requested.v1",
        "issue.human_review_restored.v1"
      ]);
    } finally {
      db.close();
    }
  });
});

async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "provider-outcome-human-review-"));
  roots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
     values ('demo', 'Demo', ?, 'codex', 1, ?, ?)`,
    [root, "2026-08-01T11:00:00Z", "2026-08-01T11:00:00Z"]
  );
  return db;
}
