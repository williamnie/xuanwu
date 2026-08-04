import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssueSupervisorEvent } from "../db/repositories/pi.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("PI supervisor issue API", () => {
  test("returns latest diagnosis, 429 wait evidence, recovery history, and executed message", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueID = insertIssue(database, "demo");
      insertRun(database, issueID);
      createIssueSupervisorEvent(database, {
        diagnosis_code: "provider_rate_limited",
        event_type: "signal",
        issue_id: issueID,
        payload_json: { raw_summary: "HTTP 429 try again later", status_code: 429 },
        project_id: "demo",
        provider: "codex",
        provider_error_category: "rate_limit",
        provider_session_id: "thread-1",
        retry_after_at: "2099-01-01T00:00:00Z",
        run_id: "run-1"
      });
      createIssueSupervisorEvent(database, {
        confidence: "high",
        decision: "wait",
        diagnosis_code: "provider_retry_after_waiting",
        event_type: "decision",
        issue_id: issueID,
        payload_json: { decision: {
          confidence: "high",
          decision: "wait",
          evidence_refs: ["event:429"],
          expected_outcome: "wait for reset",
          fallback_if_no_progress: "retry_issue",
          rationale: "provider returned 429 with retry-after",
          risk_level: "low",
          wait_until: "2099-01-01T00:00:00Z"
        } },
        project_id: "demo",
        provider_error_category: "rate_limit",
        retry_after_at: "2099-01-01T00:00:00Z"
      });
      createIssueSupervisorEvent(database, {
        action_id: "act-resume",
        action_type: "session.resume_followup",
        decision: "resume_session",
        diagnosis_code: "executor_stream_disconnected",
        event_type: "action",
        issue_id: issueID,
        payload_json: { prompt: "Inspect current state and resume safely." },
        project_id: "demo"
      });

      const response = await createDefaultRouter({ database }).handle(
        new Request(`${BASE_URL}/api/issues/${issueID}/supervisor`)
      );
      const body = await response.json() as Record<string, any>;

      expect(response.status).toBe(200);
      expect(body.latest).toMatchObject({
        diagnosis_code: "provider_retry_after_waiting",
        executed_recovery_message: "Inspect current state and resume safely."
      });
      expect(body.latest.provider_error).toMatchObject({
        diagnosis_code: "provider_rate_limited",
        raw_summary: "HTTP 429 try again later",
        status_code: 429
      });
      expect(body.latest.pi_decision).toMatchObject({
        decision: "wait",
        rationale: "provider returned 429 with retry-after",
        wait_until: "2099-01-01T00:00:00Z"
      });
      expect(body.retry_after).toMatchObject({
        at: "2099-01-01T00:00:00Z",
        reason: "provider_rate_limited",
        source: expect.stringContaining("supervisor_event:")
      });
      expect(body.retry_after.remaining_seconds).toBeGreaterThan(0);
      expect(body.summary).toMatchObject({ rate_limit_waits: 2, recovered_issues: 1 });
      expect(body.recovery_history[0]).toMatchObject({
        action_type: "session.resume_followup",
        message: "Inspect current state and resume safely."
      });
    } finally {
      database.close();
    }
  });

  test("keeps the issue view below one second with a large historical signal backlog", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "backlog");
      const issueID = insertIssue(database, "backlog");
      database.sqlite.run(`
        with recursive seq(n) as (
          select 1
          union all
          select n + 1 from seq where n < 12000
        )
        insert into issue_supervisor_events (
          issue_id, project_id, event_type, diagnosis_code, payload_json, created_at
        )
        select ?, 'backlog', 'signal', 'provider_timeout',
          json_object('raw_summary', replace(hex(zeroblob(1024)), '00', 'x')),
          '2026-06-10T09:00:00Z'
        from seq
      `, [issueID]);

      const startedAt = performance.now();
      const response = await createDefaultRouter({ database }).handle(
        new Request(`${BASE_URL}/api/issues/${issueID}/supervisor`)
      );
      const elapsedMs = performance.now() - startedAt;
      const body = await response.json() as Record<string, any>;

      expect(response.status).toBe(200);
      expect(body.summary.signals).toBe(12000);
      expect(body.recovery_history).toHaveLength(20);
      expect(elapsedMs).toBeLessThan(1000);
    } finally {
      database.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-pi-supervisor-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, auto_run, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, 0, 1, "2026-06-10T09:00:00Z", "2026-06-10T09:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectID: string): number {
  db.sqlite.run(
    `insert into issues
      (project_id, title, status, auto_retry_next_at, auto_retry_reason, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [projectID, "Supervisor issue", "in_progress", "2099-01-01T00:00:00Z", "provider_rate_limited",
      "2026-06-10T09:00:00Z", "2026-06-10T09:00:00Z"]
  );
  return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0;
}

function insertRun(db: RunnerDatabase, issueID: number): void {
  db.sqlite.run(
    `insert into issue_runs
      (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id, started_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["run-1", issueID, 1, "in_progress", "codex", "thread-1", "turn-1", "2026-06-10T09:00:00Z"]
  );
}
