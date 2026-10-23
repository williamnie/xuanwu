import { expect, test } from "bun:test";
import { type RunnerDatabase } from "../../db/database.ts";
import { ingestPiGuardianEvent } from "./guardianEventIngest.ts";
import { guardianDecisionCandidate } from "./guardianDecisionMerge.ts";
import { useTestDatabase } from "../../testing/harness.ts";

const fixtureDatabase = useTestDatabase();

test("Guardian does not invent a recovery action from a supervisor signal", async () => {
  const db = await fixtureDatabase();
  insertRunningIssue(db);
  const event = ingestPiGuardianEvent(db, {
    eventType: "guardian.supervisor.candidate",
    issueID: 737,
    normalizedPayload: {
      allowed_actions: ["issue.retry"],
      diagnosis_code: "provider_transient_network_error",
      issue_id: 737,
      issue_status: "in_progress",
      issue_updated_at: "2026-07-18T06:19:47Z",
      project_id: "demo",
      provider: "codex",
      ready: true,
      reason: "thread/start timed out",
      run_ended_at: "",
      run_id: "issue-737-attempt-1",
      run_status: "in_progress",
      signal_type: "supervisor.candidate",
    },
    projectID: "demo",
    severity: "watch",
    source: "supervisor",
    sourceEventID: "provider-timeout-737"
  });
  db.sqlite.run(
    "update issues set error='thread/start timed out', updated_at='2026-07-18T06:21:17Z' where id=737"
  );

  const candidate = guardianDecisionCandidate(event, db);
  expect(JSON.parse(candidate.actions_json)).toEqual([]);
});

function insertRunningIssue(db: RunnerDatabase): void {
  db.sqlite.run(`insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
    values ('demo', 'demo', '/tmp/demo', 'codex', 1, '2026-07-18T06:00:00Z', '2026-07-18T06:00:00Z')`);
  db.sqlite.run(`insert into issues (id, project_id, title, status, created_at, updated_at)
    values (737, 'demo', 'startup timeout', 'in_progress', '2026-07-18T06:19:47Z', '2026-07-18T06:19:47Z')`);
  db.sqlite.run(`insert into issue_runs
    (id, issue_id, attempt, status, provider, started_at, ended_at)
    values ('issue-737-attempt-1', 737, 1, 'in_progress', 'codex', '2026-07-18T06:19:47Z', '')`);
}
