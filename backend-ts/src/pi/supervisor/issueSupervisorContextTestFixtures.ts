import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createIssueSupervisorEvent, upsertProjectPiPolicy } from "../../db/repositories/pi.ts";
import { recordPiRecoveryAttempt } from "../../db/repositories/pi/recoveryAttempts.ts";
import { buildIssueSupervisorRecoveryContext } from "./issueSupervisorContext.ts";
import { latestProviderError } from "./issueSupervisorContextSupport.ts";
import { useDatabaseCleanup } from "../../testing/harness.ts";

export const trackDatabase = useDatabaseCleanup();

export const NOW = new Date("2026-06-10T08:00:00Z");

export const tempRoots: string[] = [];

export async function fixtureDb(): Promise<RunnerDatabase> {
  const root = await tempRoot("supervisor-context-db-");
  return openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
}

export async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

export function insertProject(db: RunnerDatabase, id: string, cwd: string): void {
  db.sqlite.run(`insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
    values (?, ?, ?, 'codex', 1, ?, ?)`, [id, id, cwd, "2026-06-10T01:00:00Z", "2026-06-10T01:00:00Z"]);
}

export function insertIssue(db: RunnerDatabase, input: {
  id: number;
  projectID: string;
  status: string;
  title: string;
  updatedAt: string;
}): void {
  db.sqlite.run(`insert into issues
    (id, project_id, title, description, status, attempt_count, created_at, updated_at)
    values (?, ?, ?, ?, ?, 1, ?, ?)`,
    [input.id, input.projectID, input.title, input.title, input.status, "2026-06-10T01:00:00Z", input.updatedAt]);
}

export function insertRun(db: RunnerDatabase, input: {
  attempt?: number;
  endedAt: string;
  id: string;
  issueID: number;
  provider?: string;
  sessionID: string;
  status: string;
  startedAt?: string;
  turnID: string;
}): void {
  db.sqlite.run(`insert into issue_runs
    (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id, started_at, ended_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.id, input.issueID, input.attempt ?? 1, input.status, input.provider ?? "codex", input.sessionID,
      input.turnID, input.startedAt ?? "2026-06-10T01:50:00Z", input.endedAt]);
}

export function insertSession(db: RunnerDatabase, input: {
  issueID: number;
  projectID: string;
  provider?: string;
  sessionID: string;
  status: string;
  updatedAt: string;
}): void {
  db.sqlite.run(`insert into agent_sessions
    (session_key, provider, provider_session_id, project_id, issue_id, status, raw_ref, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
    [`${input.provider ?? "codex"}:${input.sessionID}`, input.provider ?? "codex", input.sessionID, input.projectID, input.issueID, input.status, "2026-06-10T01:55:00Z", input.updatedAt]);
}

export function insertEvent(db: RunnerDatabase, input: {
  createdAt: string;
  issueID: number;
  payload: unknown;
  type: string;
}): void {
  db.sqlite.run(`insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [input.issueID, input.type, JSON.stringify(input.payload), input.createdAt]);
}
