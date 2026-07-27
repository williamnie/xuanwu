import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { createIssueRun, updateIssueRuntime } from "../db/repositories/issueRuns.ts";
import { createProject } from "../db/repositories/projects.ts";
import { upsertAgentSession } from "../db/repositories/agentSessions.ts";
import {
  reconcileStaleAgentSessions,
  reconcileStaleManagerCycleConversations,
  STALE_SESSION_RECONCILIATION_EVENT
} from "./staleSessionReconciler.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
});

describe("startup stale agent session reconciliation", () => {
  test("lets the owning Agentic Worker terminalize only historical manager cycles", async () => {
    const db = await fixtureDatabase();
    try {
      createProject(db, { cwd: "/tmp", id: "demo", name: "Demo", provider: "codex" });
      insertConversation(db, "manager-stale", "Supervisor manager cycle");
      insertConversation(db, "user-chat", "User chat");

      const result = reconcileStaleManagerCycleConversations(db, new Date("2026-07-20T01:00:00Z"));

      expect(result.stale_manager_conversations_closed).toBe(1);
      expect(conversationStatus(db, "manager-stale")).toBe("interrupted");
      expect(conversationStatus(db, "user-chat")).toBe("active");
    } finally {
      db.close();
    }
  });

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
      insertConversation(db, "manager-stale", "Supervisor manager cycle");
      insertConversation(db, "user-chat", "User chat");
      const processResult = {
        action: "none" as const, killed_process_groups: [], ownership_file: "/state/ownership.json", stale_root_pid: 0
      };

      const result = reconcileStaleAgentSessions(db, processResult, new Date("2026-07-20T01:00:00Z"));

      expect(result).toMatchObject({
        active_owner_sessions: 1,
        stale_manager_conversations_closed: 1,
        stale_sessions_closed: 2
      });
      expect(sessionStatus(db, "codex:thread-open")).toBe("inProgress");
      expect(sessionStatus(db, "codex:thread-stale")).toBe("interrupted");
      expect(sessionStatus(db, "pi-sdk:conversation-stale")).toBe("interrupted");
      expect(conversationStatus(db, "manager-stale")).toBe("interrupted");
      expect(conversationStatus(db, "user-chat")).toBe("active");
      expect(eventCount(db, STALE_SESSION_RECONCILIATION_EVENT, closedIssue.id)).toBe(1);
      expect(auditCount(db, STALE_SESSION_RECONCILIATION_EVENT)).toBe(1);

      insertConversation(db, "manager-live", "Supervisor manager cycle");
      const repeated = reconcileStaleAgentSessions(
        db,
        processResult,
        new Date("2026-07-20T01:01:00Z"),
        { reconcileManagerConversations: false }
      );
      expect(repeated.stale_manager_conversations_closed).toBe(0);
      expect(repeated.stale_sessions_closed).toBe(0);
      expect(conversationStatus(db, "manager-live")).toBe("active");
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

function insertConversation(db: RunnerDatabase, id: string, title: string): void {
  db.sqlite.run(`insert into pi_conversations
    (id, project_id, pi_agent_id, title, status, created_at, updated_at)
    values (?, 'demo', 'runner-default', ?, 'active', ?, ?)`,
  [id, title, "2026-07-20T00:00:00Z", "2026-07-20T00:00:00Z"]);
}

function conversationStatus(db: RunnerDatabase, id: string): string {
  return db.sqlite.query<{ status: string }, [string]>(
    "select status from pi_conversations where id=?"
  ).get(id)?.status ?? "";
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
