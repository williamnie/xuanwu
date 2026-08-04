import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../database.ts";
import {
  countPiRecoveryAttempts,
  getPiRecoveryAttempt,
  listPiRecoveryAttempts,
  recordPiRecoveryAttempt,
  updatePiRecoveryAttemptStatus
} from "./recoveryAttempts.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI recovery attempts", () => {
  test("keeps one row per idempotency key", async () => {
    const db = await openFixtureDatabase();
    try {
      const first = recordPiRecoveryAttempt(db, {
        action_type: "issue.retry",
        budget_window_started_at: "2026-06-18T00:00:00Z",
        diagnosis_code: "provider_timeout",
        id: "attempt-1",
        idempotency_key: "recovery:demo:101:timeout:1",
        issue_id: 101,
        project_id: "demo",
        source_decision_id: "decision-1"
      });
      const duplicate = recordPiRecoveryAttempt(db, {
        action_type: "issue.retry",
        budget_window_started_at: "2026-06-18T00:00:00Z",
        diagnosis_code: "provider_timeout",
        id: "attempt-duplicate",
        idempotency_key: "recovery:demo:101:timeout:1",
        issue_id: 101,
        project_id: "demo"
      });

      expect(duplicate.id).toBe(first.id);
      expect(listPiRecoveryAttempts(db, { issueId: 101, projectId: "demo" })).toHaveLength(1);
      expect(getPiRecoveryAttempt(db, first.id)).toMatchObject({
        id: "attempt-1",
        idempotency_key: "recovery:demo:101:timeout:1",
        status: "planned"
      });
    } finally {
      db.close();
    }
  });

  test("supports guarded status updates", async () => {
    const db = await openFixtureDatabase();
    try {
      const statuses = [
        "planned", "executing", "progress", "no_progress", "failed", "cancelled", "superseded"
      ] as const;
      for (const status of statuses) {
        const attempt = recordPiRecoveryAttempt(db, {
          action_type: "session.resume_followup",
          budget_window_started_at: "2026-06-18T00:00:00Z",
          diagnosis_code: "stream_disconnected",
          id: `attempt-${status}`,
          idempotency_key: `resume:demo:102:${status}`,
          issue_id: 102,
          project_id: "demo",
          status
        });
        expect(attempt.status).toBe(status);
      }

      expect(updatePiRecoveryAttemptStatus(db, "attempt-planned", {
        executing_started_at: "2026-06-18T00:01:00Z",
        hard_timeout_at: "2026-06-18T00:06:00Z",
        status: "executing"
      })).toMatchObject({
        executing_started_at: "2026-06-18T00:01:00Z",
        hard_timeout_at: "2026-06-18T00:06:00Z",
        status: "executing"
      });
      expect(() => recordPiRecoveryAttempt(db, {
        action_type: "issue.retry",
        budget_window_started_at: "2026-06-18T00:00:00Z",
        diagnosis_code: "bad",
        idempotency_key: "bad-status",
        issue_id: 102,
        status: "done"
      })).toThrow("invalid PI recovery attempt status done");
    } finally {
      db.close();
    }
  });

  test("redacts before and after snapshots", async () => {
    const db = await openFixtureDatabase();
    try {
      const attempt = recordPiRecoveryAttempt(db, {
        action_type: "session.resume_followup",
        before_snapshot_json: { cwd: "/Users/example/private", token: "fixture-secret" },
        budget_window_started_at: "2026-06-18T00:00:00Z",
        diagnosis_code: "stream_disconnected",
        id: "attempt-redacted",
        idempotency_key: "resume:redacted",
        issue_id: 103,
        project_id: "demo",
        status: "executing"
      });

      expect(attempt.before_snapshot_json).toContain("[redacted]");
      expect(attempt.before_snapshot_json).toContain("[redacted-path]");
      expect(attempt.before_snapshot_json).not.toContain("fixture-secret");
      expect(attempt.before_snapshot_json).not.toContain("/Users/example/private");

      const updated = updatePiRecoveryAttemptStatus(db, "attempt-redacted", {
        after_snapshot_json: { path: "/tmp/private/output", api_key: "secret-after" },
        status: "no_progress"
      });

      expect(updated.after_snapshot_json).toContain("[redacted]");
      expect(updated.after_snapshot_json).toContain("[redacted-path]");
      expect(updated.after_snapshot_json).not.toContain("secret-after");
      expect(updated.after_snapshot_json).not.toContain("/tmp/private/output");
    } finally {
      db.close();
    }
  });

  test("counts issue, session, and project windows without using issues.attempt_count", async () => {
    const db = await openFixtureDatabase();
    try {
      db.sqlite.run(`insert into projects (id, name, cwd, created_at, updated_at)
        values ('demo', 'Demo', ?, '2026-06-18T00:00:00Z', '2026-06-18T00:00:00Z')`, [process.cwd()]);
      db.sqlite.run(`insert into issues (id, project_id, title, status, attempt_count, created_at, updated_at)
        values (201, 'demo', 'Needs recovery', 'failed', 99, '2026-06-18T00:00:00Z', '2026-06-18T00:00:00Z')`);
      recordPiRecoveryAttempt(db, attemptInput("attempt-old", "issue.retry", "progress", "2026-06-17T00:00:00Z"));
      recordPiRecoveryAttempt(db, attemptInput("attempt-planned", "issue.retry", "planned", "2026-06-18T10:00:00Z"));
      recordPiRecoveryAttempt(db, attemptInput("attempt-executing", "session.resume_followup", "executing", "2026-06-18T10:10:00Z"));
      recordPiRecoveryAttempt(db, attemptInput("attempt-cancelled", "issue.retry", "cancelled", "2026-06-18T10:20:00Z"));
      recordPiRecoveryAttempt(db, {
        ...attemptInput("attempt-project", "issue.state_repair", "failed", "2026-06-18T10:30:00Z"),
        issue_id: 202,
        session_id: "session-other"
      });

      expect(countPiRecoveryAttempts(db, {
        issueId: 201,
        since: "2026-06-18T00:00:00Z",
        statuses: ["planned", "executing", "progress", "no_progress", "failed"]
      })).toBe(2);
      expect(countPiRecoveryAttempts(db, {
        actionType: "session.resume_followup",
        sessionId: "session-1",
        since: "2026-06-18T00:00:00Z"
      })).toBe(1);
      expect(countPiRecoveryAttempts(db, {
        projectId: "demo",
        since: "2026-06-18T10:00:00Z",
        statuses: ["planned", "executing", "progress", "no_progress", "failed"]
      })).toBe(3);
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-pi-recovery-attempts-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function attemptInput(id: string, actionType: string, status: string, createdAt: string) {
  return {
    action_type: actionType,
    budget_window_started_at: "2026-06-18T00:00:00Z",
    created_at: createdAt,
    diagnosis_code: "provider_timeout",
    id,
    idempotency_key: `recovery:demo:${id}`,
    issue_id: 201,
    project_id: "demo",
    session_id: "session-1",
    status,
    updated_at: createdAt
  };
}
