import { afterEach } from "bun:test";
import { type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";

import { getIssueAsWork, issueIDToWorkID } from "../domain/work/issueAdapter.ts";
import type { DependencyRelation } from "../domain/work/contracts.ts";
import { insertWorkRecord, insertWorkRelationRecord } from "../db/repositories/workLedger.ts";
import type { ExecutorProvider, ProviderRunInput } from "../providers/types.ts";
import { runAutoRunIssueWatchdogOnce } from "./issueWatchdog.ts";
import { setProjectLoopMaxParallelProjects } from "./projectLoopManager.ts";
import { useTestDatabase } from "../testing/harness.ts";

export const NOW = new Date("2026-07-20T00:00:00.000Z");

export const STALE = "2026-07-19T00:00:00.000Z";

export const fixtureDatabase = useTestDatabase();

afterEach(() => setProjectLoopMaxParallelProjects(1));

export class FixtureProvider implements ExecutorProvider {
  readonly capabilities = ["issue_execution"] as const;
  readonly id = "claude" as const;
  readonly inputs: ProviderRunInput[] = [];

  async run(input: ProviderRunInput) {
    this.inputs.push(input);
    return {
      runId: `run-${input.issueId}`,
      session: { provider: this.id, sessionId: `thread-${input.issueId}`, turnId: `turn-${input.issueId}` }
    };
  }
}

export function insertProject(db: RunnerDatabase, id: string, provider: string): void {
  db.sqlite.run(`insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
    values (?, ?, ?, ?, 1, ?, ?)`, [id, id, `/tmp/${id}`, provider, STALE, STALE]);
}

export function insertIssue(
  db: RunnerDatabase,
  title: string,
  status: string,
  projectID = "demo"
): number {
  const issue = createIssue(db, { project_id: projectID, status, title });
  db.sqlite.run("update issues set created_at=?, updated_at=? where id=?", [STALE, STALE, issue.id]);
  return issue.id;
}

export function insertOpenRun(db: RunnerDatabase, issueID: number, provider: string, startedAt: string): void {
  db.sqlite.run(`insert into issue_runs
    (id, issue_id, attempt, status, provider, started_at, ended_at)
    values (?, ?, 1, 'in_progress', ?, ?, '')`, [`issue-${issueID}-attempt-1`, issueID, provider, startedAt]);
}

export function addDependency(db: RunnerDatabase, issueID: number, dependencyID: number): void {
  ensureWork(db, issueID);
  ensureWork(db, dependencyID);
  const relation: DependencyRelation = {
    actor: { id: "watchdog-test", kind: "runner" },
    audit_event_ref: `watchdog-test:${issueID}:${dependencyID}`,
    correlation_id: `watchdog-test:${issueID}:${dependencyID}`,
    depends_on_work_id: issueIDToWorkID(dependencyID),
    kind: "depends_on",
    occurred_at: STALE,
    reason: "watchdog dependency fixture",
    relation_id: `depends-on:${issueID}:${dependencyID}`,
    work_id: issueIDToWorkID(issueID)
  };
  insertWorkRelationRecord(db, "demo", relation);
}

export function ensureWork(db: RunnerDatabase, issueID: number): void {
  const work = getIssueAsWork(db, issueID);
  if (!work) throw new Error(`missing fixture issue ${issueID}`);
  if (db.sqlite.query("select id from works where id=?").get(work.id)) return;
  insertWorkRecord(db, work);
}

export function watchdog(db: RunnerDatabase, provider: FixtureProvider, now: Date, escalateAfterMs = 60_000) {
  return runAutoRunIssueWatchdogOnce({
    database: db,
    escalateAfterMs,
    now,
    providers: { [provider.id]: provider },
    staleAfterMs: 60_000
  });
}

export function resetClaimToSameTodoState(db: RunnerDatabase, issueID: number, updatedAt: string): void {
  db.sqlite.run("delete from agent_sessions where issue_id=?", [issueID]);
  db.sqlite.run("delete from issue_runs where issue_id=?", [issueID]);
  db.sqlite.run("update issues set status='todo', attempt_count=0, updated_at=? where id=?", [updatedAt, issueID]);
}

export function eventTypes(db: RunnerDatabase, issueID: number): string[] {
  return listIssueEvents(db, issueID).map((event) => event.type);
}

export function latestPayload(db: RunnerDatabase, issueID: number, type: string): Record<string, unknown> {
  const payload = listIssueEvents(db, issueID).filter((event) => event.type === type).at(-1)?.payload ?? "{}";
  return JSON.parse(payload) as Record<string, unknown>;
}

export async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition timed out");
}
