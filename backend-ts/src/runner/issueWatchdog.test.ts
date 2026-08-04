import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { listNotifications } from "../db/repositories/notifications.ts";
import { listPiGuardianAlerts } from "../db/repositories/pi.ts";
import { getIssueAsWork, issueIDToWorkID } from "../domain/work/issueAdapter.ts";
import type { DependencyRelation } from "../domain/work/contracts.ts";
import { insertWorkRecord, insertWorkRelationRecord } from "../db/repositories/workLedger.ts";
import type { ExecutorProvider, ProviderRunInput } from "../providers/types.ts";
import { runAutoRunIssueWatchdogOnce } from "./issueWatchdog.ts";
import { isProjectLoopActive, setProjectLoopMaxParallelProjects } from "./projectLoopManager.ts";

const NOW = new Date("2026-07-20T00:00:00.000Z");
const STALE = "2026-07-19T00:00:00.000Z";
const tempRoots: string[] = [];

class FixtureProvider implements ExecutorProvider {
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

afterEach(async () => {
  setProjectLoopMaxParallelProjects(1);
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { force: true, recursive: true });
  }
});

describe("issue watchdog queue readiness", () => {
  test("keeps long dependency waits bounded, dedupes blocker Attention, then auto-recovers", async () => {
    const db = await fixtureDatabase();
    const provider = new FixtureProvider();
    try {
      insertProject(db, "demo", provider.id);
      const blocker = insertIssue(db, "blocker", "in_progress");
      const waiting = insertIssue(db, "waiting", "todo");
      addDependency(db, waiting, blocker);

      for (let hour = 0; hour < 24; hour += 1) {
        const result = await watchdog(db, provider, new Date(NOW.getTime() + hour * 60 * 60 * 1000));
        expect(result).toMatchObject({ kicked: 0, waiting: 1 });
      }

      expect(eventTypes(db, waiting).filter((type) => type === "issue.watchdog_waiting")).toHaveLength(1);
      expect(eventTypes(db, waiting)).not.toContain("issue.watchdog_kicked");
      expect(listNotifications(db, { projectID: "demo" })).toEqual([]);
      expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" })).toEqual([]);

      db.sqlite.run("update issues set status='failed', updated_at=? where id=?", [NOW.toISOString(), blocker]);
      await watchdog(db, provider, new Date(NOW.getTime() + 25 * 60 * 60 * 1000));
      await watchdog(db, provider, new Date(NOW.getTime() + 26 * 60 * 60 * 1000));
      expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" })).toHaveLength(1);
      expect(listNotifications(db, { projectID: "demo" })).toEqual([]);

      db.sqlite.run("update issues set status='done', updated_at=? where id=?", [NOW.toISOString(), blocker]);
      const recovered = await watchdog(db, provider, new Date(NOW.getTime() + 27 * 60 * 60 * 1000));
      expect(recovered).toMatchObject({ kicked: 1, waiting: 0 });
      await waitFor(() => provider.inputs.length === 1 && !isProjectLoopActive("demo"));
      expect(provider.inputs.map((input) => input.issueId)).toEqual([waiting]);
      expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" })).toEqual([]);

    } finally {
      db.close();
    }
  });

  test("retries a runnable issue three times before asking the user once", async () => {
    const db = await fixtureDatabase();
    const provider = new FixtureProvider();
    try {
      insertProject(db, "demo", provider.id);
      const issueID = insertIssue(db, "stuck", "todo");
      const originalUpdatedAt = getIssue(db, issueID)?.updated_at ?? STALE;

      const first = await watchdog(db, provider, NOW, 60_000);
      expect(first.kicked).toBe(1);
      await waitFor(() => provider.inputs.length === 1 && !isProjectLoopActive("demo"));
      resetClaimToSameTodoState(db, issueID, originalUpdatedAt);

      const second = await watchdog(db, provider, new Date(NOW.getTime() + 61_000), 60_000);
      expect(second).toMatchObject({ escalated: 0, kicked: 1 });
      await waitFor(() => provider.inputs.length === 2 && !isProjectLoopActive("demo"));
      resetClaimToSameTodoState(db, issueID, originalUpdatedAt);

      const third = await watchdog(db, provider, new Date(NOW.getTime() + 2 * 61_000), 60_000);
      expect(third).toMatchObject({ escalated: 0, kicked: 1 });
      await waitFor(() => provider.inputs.length === 3 && !isProjectLoopActive("demo"));
      resetClaimToSameTodoState(db, issueID, originalUpdatedAt);

      const escalated = await watchdog(db, provider, new Date(NOW.getTime() + 3 * 61_000), 60_000);
      const duplicate = await watchdog(db, provider, new Date(NOW.getTime() + 5 * 60_000), 60_000);
      expect(escalated).toMatchObject({ attentioned: 1, escalated: 1, kicked: 0 });
      expect(duplicate).toMatchObject({ attentioned: 0, escalated: 0, kicked: 0 });
      expect(listNotifications(db, { projectID: "demo" })).toHaveLength(1);
      expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" })).toHaveLength(1);
      expect(eventTypes(db, issueID).filter((type) => type === "issue.watchdog_kicked")).toHaveLength(3);
      expect(eventTypes(db, issueID).filter((type) => type === "issue.watchdog_needs_user")).toHaveLength(1);

      db.sqlite.run("update issues set updated_at=? where id=?", ["2026-07-19T01:00:00.000Z", issueID]);
      const reactivated = await watchdog(db, provider, new Date(NOW.getTime() + 6 * 60_000), 60_000);
      expect(reactivated.kicked).toBe(1);
      await waitFor(() => provider.inputs.length === 4 && !isProjectLoopActive("demo"));
    } finally {
      db.close();
    }
  });

  test("kicks a fresh deferred todo as soon as provider cooldown expires", async () => {
    const db = await fixtureDatabase();
    const provider = new FixtureProvider();
    try {
      insertProject(db, "demo", provider.id);
      const deferred = insertIssue(db, "retry provider startup", "todo");
      db.sqlite.run(`update issues set updated_at=?, auto_retry_next_at=?,
        auto_retry_reason=?, error=? where id=?`, [
        NOW.toISOString(),
        new Date(NOW.getTime() + 30_000).toISOString(),
        `provider_infra_transient:${provider.id}`,
        "codex thread/start timed out",
        deferred
      ]);

      const waiting = await runAutoRunIssueWatchdogOnce({
        database: db,
        now: new Date(NOW.getTime() + 29_999),
        providers: { [provider.id]: provider },
        staleAfterMs: 60_000
      });
      expect(waiting).toMatchObject({ candidates: 0, kicked: 0 });
      expect(provider.inputs).toEqual([]);

      const due = await runAutoRunIssueWatchdogOnce({
        database: db,
        now: new Date(NOW.getTime() + 30_000),
        providers: { [provider.id]: provider },
        staleAfterMs: 60_000
      });
      expect(due).toMatchObject({ candidates: 1, kicked: 1 });
      await waitFor(() => provider.inputs.length === 1 && !isProjectLoopActive("demo"));
      expect(provider.inputs.map((input) => input.issueId)).toEqual([deferred]);
    } finally {
      db.close();
    }
  });

  test("keeps project hold quiet and reports provider unavailability as deduped Attention, not needs_user", async () => {
    const db = await fixtureDatabase();
    const provider = new FixtureProvider();
    try {
      insertProject(db, "demo", provider.id);
      const waiting = insertIssue(db, "held then provider unavailable", "todo");
      db.sqlite.run(`insert into project_holds
        (project_id, reason, message, hold_since, next_check_at, updated_at)
        values ('demo', 'user_pause', 'maintenance', ?, ?, ?)`, [
        STALE, "2026-07-20T00:10:00.000Z", STALE
      ]);

      const held = await runAutoRunIssueWatchdogOnce({
        database: db, now: NOW, providers: {}, staleAfterMs: 60_000
      });
      expect(held).toMatchObject({ attentioned: 0, kicked: 0, waiting: 1 });
      expect(latestPayload(db, waiting, "issue.watchdog_waiting")).toMatchObject({
        next_check_at: "2026-07-20T00:10:00.000Z",
        not_runnable_reason: "project_hold",
        root_blocker: { project_id: "demo", reason: "user_pause" }
      });

      db.sqlite.run("delete from project_holds where project_id='demo'");
      const unavailable = await runAutoRunIssueWatchdogOnce({
        database: db, now: new Date(NOW.getTime() + 60_000), providers: {}, staleAfterMs: 60_000
      });
      const duplicate = await runAutoRunIssueWatchdogOnce({
        database: db, now: new Date(NOW.getTime() + 2 * 60_000), providers: {}, staleAfterMs: 60_000
      });
      expect(unavailable).toMatchObject({ attentioned: 1, kicked: 0, waiting: 1 });
      expect(duplicate).toMatchObject({ attentioned: 0, kicked: 0, waiting: 1 });
      expect(listNotifications(db, { projectID: "demo" })).toEqual([]);
      expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" })).toHaveLength(1);

      const recovered = await watchdog(db, provider, new Date(NOW.getTime() + 3 * 60_000));
      expect(recovered.kicked).toBe(1);
      await waitFor(() => provider.inputs.length === 1 && !isProjectLoopActive("demo"));
      expect(provider.inputs.map((input) => input.issueId)).toEqual([waiting]);
      expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" })).toEqual([]);

      resetClaimToSameTodoState(db, waiting, STALE);
      const reactivated = await runAutoRunIssueWatchdogOnce({
        database: db, now: new Date(NOW.getTime() + 4 * 60_000), providers: {}, staleAfterMs: 60_000
      });
      expect(reactivated).toMatchObject({ attentioned: 1, kicked: 0, waiting: 1 });
      expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" })).toHaveLength(1);

      db.sqlite.run("update pi_guardian_alerts set status='acked' where project_id='demo'");
      db.sqlite.run("update issues set status='done', updated_at=? where id=?", [NOW.toISOString(), waiting]);
      await runAutoRunIssueWatchdogOnce({
        database: db, now: new Date(NOW.getTime() + 5 * 60_000), providers: {}, staleAfterMs: 60_000
      });
      expect(listPiGuardianAlerts(db, { projectId: "demo", status: "acked" })).toEqual([]);
      expect(listPiGuardianAlerts(db, { projectId: "demo", status: "resolved" })).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test("keeps a queued issue quiet while the same project already has active work", async () => {
    const db = await fixtureDatabase();
    const provider = new FixtureProvider();
    setProjectLoopMaxParallelProjects(3);
    try {
      insertProject(db, "demo", provider.id);
      const running = insertIssue(db, "running", "in_progress");
      insertOpenRun(db, running, provider.id, STALE);
      const queued = insertIssue(db, "queued", "todo");

      for (let minute = 0; minute < 10; minute += 1) {
        const result = await watchdog(db, provider, new Date(NOW.getTime() + minute * 60_000));
        expect(result).toMatchObject({ escalated: 0, kicked: 0, skippedBusy: 1, waiting: 1 });
      }

      expect(provider.inputs).toEqual([]);
      expect(listNotifications(db, { projectID: "demo" })).toEqual([]);
      expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" })).toEqual([]);
      expect(latestPayload(db, queued, "issue.watchdog_waiting")).toMatchObject({
        not_runnable_reason: "project_serial_wait",
        root_blocker: [expect.objectContaining({ issue_id: running })]
      });
    } finally {
      db.close();
    }
  });

  test("records one capacity wait without needs_user noise and kicks after capacity releases", async () => {
    const db = await fixtureDatabase();
    const provider = new FixtureProvider();
    try {
      insertProject(db, "busy", provider.id);
      insertProject(db, "demo", provider.id);
      const busy = insertIssue(db, "running", "in_progress", "busy");
      insertOpenRun(db, busy, provider.id, STALE);
      const waiting = insertIssue(db, "capacity wait", "todo");

      for (let minute = 0; minute < 10; minute += 1) {
        const result = await watchdog(db, provider, new Date(NOW.getTime() + minute * 60_000));
        expect(result).toMatchObject({ kicked: 0, skippedBusy: 1, waiting: 1 });
      }
      expect(eventTypes(db, waiting).filter((type) => type === "issue.watchdog_waiting")).toHaveLength(1);
      expect(listNotifications(db, { projectID: "demo" })).toEqual([]);
      expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" })).toEqual([]);

      db.sqlite.run("update issues set status='done', updated_at=? where id=?", [NOW.toISOString(), busy]);
      db.sqlite.run("update issue_runs set status='done', ended_at=? where issue_id=?", [NOW.toISOString(), busy]);
      const released = await watchdog(db, provider, new Date(NOW.getTime() + 11 * 60_000));
      expect(released.kicked).toBe(1);
      await waitFor(() => provider.inputs.length === 1 && !isProjectLoopActive("demo"));
      expect(provider.inputs.map((input) => input.issueId)).toEqual([waiting]);
    } finally {
      db.close();
    }
  });

  test("alerts once when a terminal provider Session leaves an in-progress Issue and open Run", async () => {
    const db = await fixtureDatabase();
    const provider = new FixtureProvider();
    try {
      insertProject(db, "demo", provider.id);
      const issueID = insertIssue(db, "terminal mismatch", "in_progress");
      insertOpenRun(db, issueID, provider.id, STALE);
      db.sqlite.run(
        "update issue_runs set provider_session_id=?, provider_turn_id=? where issue_id=?",
        ["thread-terminal", "turn-terminal", issueID]
      );
      db.sqlite.run(
        `insert into agent_sessions
          (session_key, provider, provider_session_id, project_id, issue_id, status, raw_ref, created_at, updated_at)
         values (?, ?, ?, 'demo', ?, 'completed', ?, ?, ?)`,
        [
          `${provider.id}:thread-terminal`,
          provider.id,
          "thread-terminal",
          issueID,
          JSON.stringify({ provider_turn_id: "turn-terminal" }),
          STALE,
          STALE
        ]
      );

      const first = await watchdog(db, provider, NOW);
      const duplicate = await watchdog(db, provider, new Date(NOW.getTime() + 30_000));

      expect(first).toMatchObject({ attentioned: 1, candidates: 1, escalated: 1, scanned: 1 });
      expect(duplicate).toMatchObject({ attentioned: 0, escalated: 0 });
      expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" })).toContainEqual(
        expect.objectContaining({
          alert_type: "issue_runtime_mismatch_terminal_session_open_run",
          issue_id: issueID
        })
      );
      expect(listNotifications(db, { projectID: "demo" })).toContainEqual(
        expect.objectContaining({ event: "pi.needs_user", issue_id: issueID })
      );
      expect(eventTypes(db, issueID)).toContain("issue.watchdog_runtime_mismatch");

      db.sqlite.run(
        "update issues set status='pending_verification', updated_at=? where id=?",
        [NOW.toISOString(), issueID]
      );
      db.sqlite.run(
        "update issue_runs set status='done', ended_at=? where issue_id=?",
        [NOW.toISOString(), issueID]
      );
      await watchdog(db, provider, new Date(NOW.getTime() + 60_000));
      expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" })).toEqual([]);
      expect(listPiGuardianAlerts(db, { projectId: "demo", status: "resolved" })).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-issue-watchdog-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string, provider: string): void {
  db.sqlite.run(`insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
    values (?, ?, ?, ?, 1, ?, ?)`, [id, id, `/tmp/${id}`, provider, STALE, STALE]);
}

function insertIssue(
  db: RunnerDatabase,
  title: string,
  status: string,
  projectID = "demo"
): number {
  const issue = createIssue(db, { project_id: projectID, status, title });
  db.sqlite.run("update issues set created_at=?, updated_at=? where id=?", [STALE, STALE, issue.id]);
  return issue.id;
}

function insertOpenRun(db: RunnerDatabase, issueID: number, provider: string, startedAt: string): void {
  db.sqlite.run(`insert into issue_runs
    (id, issue_id, attempt, status, provider, started_at, ended_at)
    values (?, ?, 1, 'in_progress', ?, ?, '')`, [`issue-${issueID}-attempt-1`, issueID, provider, startedAt]);
}

function addDependency(db: RunnerDatabase, issueID: number, dependencyID: number): void {
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

function ensureWork(db: RunnerDatabase, issueID: number): void {
  const work = getIssueAsWork(db, issueID);
  if (!work) throw new Error(`missing fixture issue ${issueID}`);
  if (db.sqlite.query("select id from works where id=?").get(work.id)) return;
  insertWorkRecord(db, work);
}

function loopInput(db: RunnerDatabase, provider: FixtureProvider, now: Date) {
  return { database: db, now, projectId: "demo", providers: { [provider.id]: provider } };
}

function watchdog(db: RunnerDatabase, provider: FixtureProvider, now: Date, escalateAfterMs = 60_000) {
  return runAutoRunIssueWatchdogOnce({
    database: db,
    escalateAfterMs,
    now,
    providers: { [provider.id]: provider },
    staleAfterMs: 60_000
  });
}

function resetClaimToSameTodoState(db: RunnerDatabase, issueID: number, updatedAt: string): void {
  db.sqlite.run("delete from agent_sessions where issue_id=?", [issueID]);
  db.sqlite.run("delete from issue_runs where issue_id=?", [issueID]);
  db.sqlite.run("update issues set status='todo', attempt_count=0, updated_at=? where id=?", [updatedAt, issueID]);
}

function eventTypes(db: RunnerDatabase, issueID: number): string[] {
  return listIssueEvents(db, issueID).map((event) => event.type);
}

function latestPayload(db: RunnerDatabase, issueID: number, type: string): Record<string, unknown> {
  const payload = listIssueEvents(db, issueID).filter((event) => event.type === type).at(-1)?.payload ?? "{}";
  return JSON.parse(payload) as Record<string, unknown>;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition timed out");
}
