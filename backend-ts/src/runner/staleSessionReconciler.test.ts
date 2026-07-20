import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { createIssueRun, updateIssueRuntime } from "../db/repositories/issueRuns.ts";
import { createProject } from "../db/repositories/projects.ts";
import { upsertAgentSession } from "../db/repositories/agentSessions.ts";
import { reconcileStaleAgentSessions, STALE_SESSION_RECONCILIATION_EVENT } from "./staleSessionReconciler.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
});

describe("startup stale agent session reconciliation", () => {
  test("interrupts sessions without an open Run owner, audits them, and preserves the recoverable owner", async () => {
    const db = await fixtureDatabase();
    try {
      createProject(db, { cwd: "/tmp", id: "demo", name: "Demo", provider: "codex" });
      const openIssue = createIssue(db, { project_id: "demo", status: "in_progress", title: "open" });
      const closedIssue = createIssue(db, { project_id: "demo", status: "done", title: "closed" });
      createIssueRun(db, openIssue.id);
      updateIssueRuntime(db, openIssue.id, { provider: "codex", provider_session_id: "thread-open" });
      upsertAgentSession(db, {
        issue_id: openIssue.id, project_id: "demo", provider: "codex",
        provider_session_id: "thread-open", status: "inProgress"
      });
      upsertAgentSession(db, {
        issue_id: closedIssue.id, project_id: "demo", provider: "codex",
        provider_session_id: "thread-stale", status: "running"
      });
      upsertAgentSession(db, { provider: "pi-sdk", provider_session_id: "conversation-stale", status: "active" });
      const processResult = {
        action: "none" as const, killed_process_groups: [], ownership_file: "/state/ownership.json", stale_root_pid: 0
      };

      const result = reconcileStaleAgentSessions(db, processResult, new Date("2026-07-20T01:00:00Z"));

      expect(result).toMatchObject({ active_owner_sessions: 1, stale_sessions_closed: 2 });
      expect(sessionStatus(db, "codex:thread-open")).toBe("inProgress");
      expect(sessionStatus(db, "codex:thread-stale")).toBe("interrupted");
      expect(sessionStatus(db, "pi-sdk:conversation-stale")).toBe("interrupted");
      expect(eventCount(db, STALE_SESSION_RECONCILIATION_EVENT, closedIssue.id)).toBe(1);
      expect(auditCount(db, STALE_SESSION_RECONCILIATION_EVENT)).toBe(1);

      const repeated = reconcileStaleAgentSessions(db, processResult, new Date("2026-07-20T01:01:00Z"));
      expect(repeated.stale_sessions_closed).toBe(0);
      expect(eventCount(db, STALE_SESSION_RECONCILIATION_EVENT, closedIssue.id)).toBe(1);
      expect(auditCount(db, STALE_SESSION_RECONCILIATION_EVENT)).toBe(2);
    } finally {
      db.close();
    }
  });
});

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "stale-session-reconciler-"));
  roots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function sessionStatus(db: RunnerDatabase, key: string): string {
  return db.sqlite.query<{ status: string }, [string]>("select status from agent_sessions where session_key=?").get(key)?.status ?? "";
}

function eventCount(db: RunnerDatabase, type: string, issueID: number): number {
  return db.sqlite.query<{ count: number }, [string, number]>(
    "select count(*) as count from issue_events where type=? and issue_id=?"
  ).get(type, issueID)?.count ?? 0;
}

function auditCount(db: RunnerDatabase, type: string): number {
  return db.sqlite.query<{ count: number }, [string]>(
    "select count(*) as count from pi_action_events where event_type=?"
  ).get(type)?.count ?? 0;
}
