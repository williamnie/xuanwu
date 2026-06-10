import { afterEach, describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { runMigrations } from "../db/migrations.ts";
import { migrations } from "../db/schema/index.ts";
import {
  createIssueSupervisorEvent,
  listIssueSupervisorEvents,
  readProjectPiPolicy,
  upsertProjectPiPolicy
} from "../db/repositories/pi.ts";
import { classifyPiActionRisk } from "./actionGate.ts";
import {
  PI_SUPERVISOR_ACTION_PAYLOAD_SCHEMAS,
  PI_SUPERVISOR_DECISION_ACTION_TYPES,
  PI_SUPERVISOR_DECISION_JSON_SCHEMA,
  PI_SUPERVISOR_DECISIONS,
  PI_SUPERVISOR_DIAGNOSIS_CODES
} from "./issueSupervisorRecovery.ts";
import { issueSupervisorRecoveryFixtures } from "./issueSupervisorRecoveryFixtures.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI issue supervisor recovery contract", () => {
  test("defines diagnosis codes, decision JSON schema, and action payload schemas", () => {
    expect(PI_SUPERVISOR_DIAGNOSIS_CODES).toEqual([
      "executor_stream_disconnected",
      "provider_rate_limited",
      "provider_retry_after_waiting",
      "provider_retry_after_ready",
      "provider_transient_network_error",
      "session_no_recent_progress",
      "session_recovery_exhausted",
      "requires_human_decision"
    ]);
    expect(PI_SUPERVISOR_DECISIONS).toEqual([
      "wait",
      "resume_session",
      "steer_running_turn",
      "retry_issue",
      "needs_user",
      "blocked",
      "noop"
    ]);
    expect(Value.Check(PI_SUPERVISOR_DECISION_JSON_SCHEMA, {
      confidence: "high",
      decision: "resume_session",
      evidence_refs: ["event:157762", "run:issue-298-attempt-1"],
      expected_outcome: "provider session continues and emits progress",
      fallback_if_no_progress: "needs_user",
      rationale: "stream disconnected after reconnect attempts",
      recovery_message: "Inspect current state, avoid duplicate work, and continue if safe.",
      risk_level: "medium"
    })).toBe(true);
    expect(Value.Check(PI_SUPERVISOR_DECISION_JSON_SCHEMA, { decision: "restart_everything" })).toBe(false);
    expect(Object.keys(PI_SUPERVISOR_ACTION_PAYLOAD_SCHEMAS).sort()).toEqual([
      "issue.retry",
      "issue.retry_after",
      "issue.supervisor_decision",
      "needs_user.escalate",
      "session.resume_followup",
      "session.steer"
    ]);
    expect(PI_SUPERVISOR_DECISION_ACTION_TYPES.resume_session).toEqual(["session.resume_followup"]);
    expect(PI_SUPERVISOR_DECISION_ACTION_TYPES.wait).toEqual(["issue.retry_after"]);
    expect(Value.Check(PI_SUPERVISOR_ACTION_PAYLOAD_SCHEMAS["session.resume_followup"], {
      decision_id: "decision-298-1",
      diagnosis_code: "executor_stream_disconnected",
      issue_id: 298,
      prompt: "PI generated recovery message",
      provider: "codex",
      provider_session_id: "thread-298"
    })).toBe(true);
  });

  test("extends project policy with supervisor mode, allowed actions, cooldown, budget, and 429 wait policy", async () => {
    const db = await openFixtureDatabase();
    try {
      expect(readProjectPiPolicy(db, "demo")).toMatchObject({
        allowed_supervisor_actions_json: "[]",
        supervisor_cooldown_seconds: 300,
        supervisor_max_recoveries_per_issue: 2,
        supervisor_max_recoveries_per_project_per_hour: 10,
        supervisor_mode: "propose_only",
        supervisor_rate_limit_wait_policy: "respect_retry_after"
      });

      const policy = upsertProjectPiPolicy(db, {
        allowed_supervisor_actions_json: ["session.resume_followup", "issue.retry_after"],
        project_id: "demo",
        supervisor_cooldown_seconds: 900,
        supervisor_max_recoveries_per_issue: 3,
        supervisor_max_recoveries_per_project_per_hour: 12,
        supervisor_mode: "autonomous",
        supervisor_rate_limit_wait_policy: "ask"
      });

      expect(policy).toMatchObject({
        supervisor_cooldown_seconds: 900,
        supervisor_max_recoveries_per_issue: 3,
        supervisor_max_recoveries_per_project_per_hour: 12,
        supervisor_mode: "autonomous",
        supervisor_rate_limit_wait_policy: "ask"
      });
      expect(JSON.parse(policy.allowed_supervisor_actions_json)).toEqual([
        "session.resume_followup",
        "issue.retry_after"
      ]);
    } finally {
      db.close();
    }
  });

  test("persists a signal to decision to action to result supervisor event chain", async () => {
    const db = await openFixtureDatabase();
    try {
      createIssueSupervisorEvent(db, {
        diagnosis_code: "executor_stream_disconnected",
        event_type: "signal",
        issue_id: 298,
        payload_json: { summary: "Reconnecting... 1/5" },
        project_id: "codex-issue-runner",
        provider: "codex",
        provider_session_id: "thread-298",
        run_id: "issue-298-attempt-1"
      });
      createIssueSupervisorEvent(db, {
        confidence: "high",
        decision: "resume_session",
        diagnosis_code: "executor_stream_disconnected",
        event_type: "decision",
        issue_id: 298,
        payload_json: { recovery_message: "continue after inspecting current state" },
        project_id: "codex-issue-runner"
      });
      createIssueSupervisorEvent(db, {
        action_id: "pi-action-298-resume",
        action_type: "session.resume_followup",
        decision: "resume_session",
        event_type: "action",
        issue_id: 298,
        payload_json: { prompt: "continue after inspecting current state" },
        project_id: "codex-issue-runner"
      });
      createIssueSupervisorEvent(db, {
        action_id: "pi-action-298-resume",
        decision: "resume_session",
        event_type: "result",
        issue_id: 298,
        payload_json: { outcome: "progress" },
        project_id: "codex-issue-runner"
      });

      const events = listIssueSupervisorEvents(db, { issueId: 298 });
      expect(events.map((event) => event.event_type)).toEqual(["signal", "decision", "action", "result"]);
      expect(events[0]).toMatchObject({
        diagnosis_code: "executor_stream_disconnected",
        issue_id: 298,
        provider: "codex",
        provider_session_id: "thread-298",
        run_id: "issue-298-attempt-1"
      });
      expect(events[2]).toMatchObject({ action_id: "pi-action-298-resume", action_type: "session.resume_followup" });
      expect(JSON.parse(events[3]?.payload_json ?? "{}")).toEqual({ outcome: "progress" });
    } finally {
      db.close();
    }
  });

  test("migrates legacy databases with supervisor event table and policy columns", async () => {
    const root = await tempPath("codex-runner-supervisor-migrate-");
    const stateDir = join(root, "state");
    await createLegacyDatabase(join(stateDir, "runner.db"));

    const migrated = await openDatabase({ stateDir });
    try {
      expect(tableNames(migrated)).toContain("issue_supervisor_events");
      expect(columnNames(migrated, "issue_supervisor_events")).toEqual(expect.arrayContaining([
        "action_id",
        "action_type",
        "confidence",
        "decision",
        "diagnosis_code",
        "event_type",
        "provider_error_category",
        "retry_after_at"
      ]));
      expect(columnNames(migrated, "project_pi_policies")).toEqual(expect.arrayContaining([
        "allowed_supervisor_actions_json",
        "supervisor_cooldown_seconds",
        "supervisor_max_recoveries_per_issue",
        "supervisor_max_recoveries_per_project_per_hour",
        "supervisor_mode",
        "supervisor_rate_limit_wait_policy"
      ]));
      expect(migrated.sqlite.query("select id from schema_migrations where id='020_issue_supervisor_recovery'").get())
        .toEqual({ id: "020_issue_supervisor_recovery" });
    } finally {
      migrated.close();
    }
  });

  test("exports reusable fixtures for stream disconnect, 429 retry-after, and no-progress recovery loops", () => {
    expect(issueSupervisorRecoveryFixtures.map((fixture) => fixture.id)).toEqual([
      "issue-298-stream-disconnect",
      "provider-429-retry-after",
      "consecutive-recovery-no-progress"
    ]);
    for (const fixture of issueSupervisorRecoveryFixtures) {
      expect(fixture.events[0]?.event_type).toBe("signal");
      for (const decision of fixture.decisions) {
        expect(Value.Check(PI_SUPERVISOR_DECISION_JSON_SCHEMA, decision)).toBe(true);
      }
    }
    expect(issueSupervisorRecoveryFixtures[0]?.events[0]).toMatchObject({
      diagnosis_code: "executor_stream_disconnected",
      issue_id: 298
    });
    expect(issueSupervisorRecoveryFixtures[1]?.events[0]).toMatchObject({
      diagnosis_code: "provider_rate_limited",
      provider_error_category: "rate_limit",
      retry_after_at: "2026-06-10T02:10:00Z"
    });
    expect(issueSupervisorRecoveryFixtures[2]?.decisions.at(-1)).toMatchObject({
      decision: "needs_user",
      fallback_if_no_progress: "blocked"
    });
  });

  test("classifies new supervisor action types with stable gate risk", () => {
    expect(classifyPiActionRisk("issue.supervisor_decision")).toMatchObject({ gate: "safe", riskLevel: "low" });
    expect(classifyPiActionRisk("issue.retry_after")).toMatchObject({ gate: "safe", riskLevel: "low" });
    expect(classifyPiActionRisk("session.resume_followup")).toMatchObject({ gate: "confirm", riskLevel: "medium" });
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await tempPath("codex-runner-supervisor-");
  return openDatabase({ stateDir: join(root, "state") });
}

async function tempPath(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(path);
  return path;
}

async function createLegacyDatabase(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    runMigrations(db, migrations.slice(0, supervisorMigrationIndex()));
  } finally {
    db.close();
  }
}

function supervisorMigrationIndex(): number {
  const index = migrations.findIndex((migration) => migration.id === "020_issue_supervisor_recovery");
  if (index < 0) throw new Error("supervisor recovery migration missing");
  return index;
}

function tableNames(connection: RunnerDatabase): string[] {
  return connection.sqlite.query("select name from sqlite_master where type='table' order by name asc")
    .all().map((row) => (row as { name: string }).name);
}

function columnNames(connection: RunnerDatabase, table: string): string[] {
  return connection.sqlite.query(`pragma table_info(${table})`).all()
    .map((row) => (row as { name: string }).name);
}
