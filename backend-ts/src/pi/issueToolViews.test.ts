import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { createIssueExecutionStatus } from "./issueToolViews.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { force: true, recursive: true });
  }
});

describe("PI issue execution status completion projection", () => {
  test("reports an ended Run as PI acceptance pending without making Evidence a blocker", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db);
      const issue = createIssue(db, {
        description: "Implement the fix. 不要 commit、push 或 deploy。",
        project_id: "demo",
        status: "pending_verification",
        title: "Completed code with missing Handoff"
      });
      db.sqlite.run(
        `insert into issue_runs (
          id, issue_id, attempt, status, provider, started_at, ended_at, exit_reason, error
        ) values (?, ?, ?, 'pending_verification', 'codex', ?, ?, 'explicit_status_update', ?)`,
        [
          `issue-${issue.id}-attempt-1`,
          issue.id,
          1,
          "2026-07-23T10:00:00.000Z",
          "2026-07-23T10:10:00.000Z",
          "Verification pending: persisted Handoff missing"
        ]
      );
      recordIssueEvent(db, issue.id, "issue.verification_gate_outcome.v1", {
        evidence_ids: ["xw:evidence:issue_events:1", "xw:evidence:git:1"],
        handoff_gap: "Completion requires a persisted ready or delivered Handoff",
        handoff_id: null,
        target_status: "pending_verification"
      });

      expect(createIssueExecutionStatus(db, issue.id)).toMatchObject({
        completion: {
          blocker: null,
          formal_status: "pending_verification",
          handoff_present: false,
          implementation_complete: true,
          retry_recommended: false,
          state: "acceptance_pending",
          truth_basis: {
            evidence_count: 2,
            latest_run_status: "pending_verification"
          }
        },
        latest_run: {
          status: "pending_verification"
        }
      });
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-issue-tool-views-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase): void {
  const timestamp = "2026-07-23T09:00:00.000Z";
  db.sqlite.run(
    `insert into projects (id, name, cwd, created_at, updated_at)
     values ('demo', 'Demo', '/tmp/demo', ?, ?)`,
    [timestamp, timestamp]
  );
}
