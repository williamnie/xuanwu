import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listPiActions, listPiGuardianEvents, upsertProjectPiPolicy } from "../db/repositories/pi.ts";
import { runScheduleLayerCycle } from "./piAutoManageScheduler.ts";
import { signalOpenRunTerminalProviderErrors } from "./providerTerminalSignals.ts";
import type { ExecutorProvider, ProviderRunInput, SessionMessageInput } from "../providers/types.ts";

const tempRoots: string[] = [];
const NOW = new Date("2026-06-22T08:40:00Z");

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("provider terminal PI signals", () => {
  test("backfills latest terminal provider error for an open run while supervisor policy is off", async () => {
    const db = await openFixtureDatabase();
    try {
      seedStuckIssue(db, 525);
      insertTerminalProviderError(db, 525);

      const result = signalOpenRunTerminalProviderErrors(db, { now: new Date("2026-06-22T15:41:00Z") });
      const signal = listPiGuardianEvents(db, { issueId: 525, status: "pending" })[0];

      expect(result).toMatchObject({ scanned: 1, signaled: 1 });
      expect(signal).toMatchObject({
        event_type: "guardian.supervisor.candidate",
        issue_id: 525,
        project_id: "demo",
        severity: "watch",
        source: "supervisor"
      });
      expect(JSON.parse(signal?.normalized_payload_json ?? "{}")).toMatchObject({
        diagnosis_code: "provider_rate_limited",
        provider: "codex",
        provider_error_category: "rate_limit",
        provider_session_id: "thread-525",
        provider_turn_id: "turn-525",
        ready: true,
        signal_type: "supervisor.candidate"
      });

      expect(signalOpenRunTerminalProviderErrors(db, { now: new Date("2026-06-22T15:42:00Z") }))
        .toMatchObject({ scanned: 1, signaled: 0 });
      expect(listPiGuardianEvents(db, { issueId: 525, status: "pending" })).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("keeps backfilled provider errors alert-only until PI chooses a concrete action", async () => {
    const db = await openFixtureDatabase();
    const provider = new ResumeProvider();
    try {
      seedStuckIssue(db, 525);
      insertTerminalProviderError(db, 525);

      const first = await runScheduleLayerCycle({
        database: db,
        providers: { codex: provider },
        runProjectCycle: async () => ({}),
        runSupervisor: false,
        watchdogNow: NOW
      });
      db.sqlite.run("update pi_guardian_decisions set cooldown_until='' where project_id='demo'");
      const second = await runScheduleLayerCycle({
        database: db,
        providers: { codex: provider },
        runProjectCycle: async () => ({}),
        runSupervisor: false,
        watchdogNow: new Date(NOW.getTime() + 31_000)
      });

      expect(first.providerTerminalSignals).toMatchObject({ scanned: 1, signaled: 1 });
      expect(second.providerTerminalSignals).toMatchObject({ scanned: 1, signaled: 0 });
      expect(second.guardianActionDispatch).toMatchObject({ completed: 0, failed: 0, scanned: 0 });
      expect(provider.calls).toEqual([]);
      expect(listPiActions(db, { issueId: 525 })).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("does not replay terminal provider errors from a previous closed run", async () => {
    const db = await openFixtureDatabase();
    try {
      seedStuckIssue(db, 526);
      insertTerminalProviderError(db, 526);
      replaceWithFreshOpenRun(db, 526);

      const result = signalOpenRunTerminalProviderErrors(db, { now: new Date("2026-06-22T16:01:00Z") });

      expect(result).toMatchObject({ scanned: 1, signaled: 0, skipped: 1 });
      expect(listPiGuardianEvents(db, { issueId: 526, status: "pending" })).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-bun-provider-terminal-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function seedStuckIssue(db: RunnerDatabase, issueID: number): void {
  insertProject(db, "demo");
  upsertProjectPiPolicy(db, { project_id: "demo", allowed_supervisor_actions_json: [] });
  insertStuckIssue(db, issueID);
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, created_at, updated_at) values (?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "codex", "2026-06-22T15:00:00Z", "2026-06-22T15:00:00Z"]
  );
}

function insertStuckIssue(db: RunnerDatabase, issueID: number): void {
  db.sqlite.run(
    `insert into issues (id, project_id, title, status, codex_thread_id, codex_turn_id, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [issueID, "demo", "Runtime", "in_progress", "thread-525", "turn-525", "2026-06-22T15:00:00Z", "2026-06-22T15:40:34Z"]
  );
  db.sqlite.run(
    `insert into issue_runs (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id,
      codex_thread_id, codex_turn_id, started_at, ended_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["issue-525-attempt-1", issueID, 1, "in_progress", "codex", "thread-525", "turn-525", "thread-525", "turn-525", "2026-06-22T15:00:00Z", ""]
  );
  db.sqlite.run(
    `insert into agent_sessions (session_key, provider, provider_session_id, project_id, issue_id, status, raw_ref, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["codex:thread-525", "codex", "thread-525", "demo", issueID, "failed", JSON.stringify({ provider_turn_id: "turn-525" }), "2026-06-22T15:00:00Z", "2026-06-22T15:40:34Z"]
  );
}

function insertTerminalProviderError(db: RunnerDatabase, issueID: number): void {
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, "issue.log", JSON.stringify({
      type: "error",
      provider: "codex",
      raw_method: "error",
      raw_payload: JSON.stringify({
        error: {
          codexErrorInfo: "serverOverloaded",
          message: "Selected model is at capacity. Please try a different model."
        },
        willRetry: false,
        threadId: "thread-525",
        turnId: "turn-525"
      }),
      status: "failed",
      error: "Selected model is at capacity. Please try a different model."
    }), "2026-06-22T15:40:34Z"]
  );
}

function replaceWithFreshOpenRun(db: RunnerDatabase, issueID: number): void {
  db.sqlite.run(
    "update issue_runs set status='failed', ended_at=? where issue_id=? and ended_at=''",
    ["2026-06-22T15:40:35Z", issueID]
  );
  db.sqlite.run(
    `insert into issue_runs (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id,
      codex_thread_id, codex_turn_id, started_at, ended_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [`issue-${issueID}-attempt-2`, issueID, 2, "in_progress", "codex", "thread-new", "turn-new",
      "thread-new", "turn-new", "2026-06-22T16:00:00Z", ""]
  );
  db.sqlite.run("update issues set codex_thread_id=?, codex_turn_id=?, updated_at=? where id=?", [
    "thread-new", "turn-new", "2026-06-22T16:00:00Z", issueID
  ]);
}

class ResumeProvider implements ExecutorProvider {
  readonly capabilities = ["issue_execution", "resume_session"] as const;
  readonly calls: Array<{ prompt: string; sessionId: string }> = [];
  readonly id = "codex" as const;
  async run(input: ProviderRunInput) { return { runId: `codex-run-${input.issueId}` }; }
  async readSession(sessionId: string) {
    return { provider_session_id: sessionId, provider_turn_id: "turn-525", sessionId };
  }
  async sendSessionMessage(input: SessionMessageInput) {
    this.calls.push({ prompt: input.prompt || "", sessionId: input.sessionId });
    return { provider: "codex" as const, provider_session_id: input.sessionId, sessionId: input.sessionId, turn_id: "turn-followup" };
  }
}
