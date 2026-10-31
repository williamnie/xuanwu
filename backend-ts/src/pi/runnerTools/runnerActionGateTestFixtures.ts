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

export const trackDatabase = useDatabaseCleanup();

export async function openFixture(): Promise<{ close(): Promise<void>; db: RunnerDatabase; project: Project }> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-bun-pi-action-gate-"));
  const db = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
  db.sqlite.run(
    `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    ["demo", "Demo", join(root, "project"), 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const project = getProject(db, "demo");
  if (!project) throw new Error("missing fixture project");
  return { db, project, close: async () => { db.close(); await rm(root, { recursive: true, force: true }); } };
}

export function insertIssue(db: RunnerDatabase, input: { projectID: string; status: string; title: string }): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [input.projectID, input.title, input.status, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing issue id");
  return row.id;
}

export function insertAgentSession(db: RunnerDatabase, input: { projectID: string; sessionKey: string }): void {
  const [, sessionID] = input.sessionKey.split(":");
  db.sqlite.run(
    `insert into agent_sessions
      (session_key, provider, provider_session_id, project_id, title, status, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.sessionKey, "codex", sessionID, input.projectID, "Thread 1", "running",
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}
