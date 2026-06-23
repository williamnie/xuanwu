import { afterEach, describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { runMigrations } from "../db/migrations.ts";
import { issueSupervisorRecoveryMigration } from "../db/schema/020_issue_supervisor_recovery.ts";
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
import {
  classifyRecoveryDiagnosis,
  isAutomaticRecoveryBlockedDiagnosis,
  isTransientRecoveryDiagnosis
} from "./recoveryDiagnosis.ts";
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
      "provider_eof",
      "stream_disconnect",
      "executor_stream_disconnected",
      "provider_timeout",
      "provider_rate_limited",
      "provider_retry_after_waiting",
      "provider_retry_after_ready",
      "provider_transient_network_error",
      "provider_runtime_unavailable",
      "transport_restart",
      "scheduler_retryable_error",
      "session_no_recent_progress",
      "missing_user_input",
      "ambiguous_requirement",
      "auth_required",
      "approval_denied",
      "external_account_required",
      "business_decision_required",
      "build_broken_needs_decision",
      "requires_human_decision",
      "unsafe_or_external",
      "session_recovery_exhausted",
      "recovery_budget_exhausted"
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

  test("classifies canonical recovery diagnoses deterministically", () => {
    expect(classifyRecoveryDiagnosis({ diagnosisCode: "provider_timeout" })).toMatchObject({
      failure_class: "transient",
      severity: "watch"
    });
    expect(classifyRecoveryDiagnosis({ diagnosisCode: "auth_required" })).toMatchObject({
      failure_class: "needs_context",
      severity: "actionable"
    });
    expect(classifyRecoveryDiagnosis({ diagnosisCode: "unsafe_or_external" })).toMatchObject({
      failure_class: "unsafe",
      severity: "urgent"
    });
    expect(classifyRecoveryDiagnosis({ diagnosisCode: "session_recovery_exhausted" })).toMatchObject({
      failure_class: "exhausted",
      severity: "actionable"
    });
    expect(classifyRecoveryDiagnosis({
      diagnosisCode: "future_unknown_code",
      providerErrorCategory: "network"
    })).toMatchObject({
      failure_class: "needs_context",
      severity: "actionable"
    });
    expect(isTransientRecoveryDiagnosis("provider_eof")).toBe(true);
    expect(isAutomaticRecoveryBlockedDiagnosis("missing_user_input")).toBe(true);
  });

  test("extends project policy with supervisor mode, allowed actions, cooldown, budget, and 429 wait policy", async () => {
    const db = await openFixtureDatabase();
    try {
      expect(readProjectPiPolicy(db, "demo")).toMatchObject({
        allowed_supervisor_actions_json: "[\"session.resume_followup\",\"issue.retry_after\",\"issue.retry\",\"needs_user.escalate\"]",
        supervisor_cooldown_seconds: 300,
        supervisor_max_recoveries_per_issue: 2,
        supervisor_max_recoveries_per_project_per_hour: 10,
        supervisor_mode: "autonomous",
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

  test("upgrades existing supervisor policies to default autonomous recovery", async () => {
    const db = await openFixtureDatabase();
    try {
      db.sqlite.run(`insert into project_pi_policies
        (project_id, default_mode, timezone, working_hours_json, quiet_hours_json, retry_policy_json,
          concurrency_policy_json, verification_policy_json, allowed_actions_json, allowed_mcp_capabilities_json,
          allowed_skill_intents_json, allowed_supervisor_actions_json, supervisor_mode, supervisor_cooldown_seconds,
          supervisor_max_recoveries_per_issue, supervisor_max_recoveries_per_project_per_hour,
          supervisor_rate_limit_wait_policy, created_at, updated_at)
        values (?, 'manual', 'UTC', '{}', '{}', '{"enabled":false,"max_attempts":0,"backoff_minutes":[]}',
          '{"max_parallel_issues":1,"max_parallel_pi_cycles":1}',
          '{"pending_timeout_minutes":1440,"on_timeout":"escalate","evidence_required":true}',
          '[]', '[]', '[]', '[]', 'watchdog', 300, 2, 10, 'respect_retry_after', ?, ?)`,
      ["legacy-default", "2026-06-22T00:00:00Z", "2026-06-22T00:00:00Z"]);
      db.sqlite.run(`insert into project_pi_policies
        (project_id, default_mode, timezone, working_hours_json, quiet_hours_json, retry_policy_json,
          concurrency_policy_json, verification_policy_json, allowed_actions_json, allowed_mcp_capabilities_json,
          allowed_skill_intents_json, allowed_supervisor_actions_json, supervisor_mode, supervisor_cooldown_seconds,
          supervisor_max_recoveries_per_issue, supervisor_max_recoveries_per_project_per_hour,
          supervisor_rate_limit_wait_policy, created_at, updated_at)
        values (?, 'manual', 'UTC', '{}', '{}', '{"enabled":false,"max_attempts":0,"backoff_minutes":[]}',
          '{"max_parallel_issues":1,"max_parallel_pi_cycles":1}',
          '{"pending_timeout_minutes":1440,"on_timeout":"escalate","evidence_required":true}',
          '[]', '[]', '[]', '[]', 'off', 300, 2, 10, 'respect_retry_after', ?, ?)`,
      ["explicit-off", "2026-06-22T00:00:00Z", "2026-06-22T00:00:00Z"]);

      issueSupervisorRecoveryMigration.apply?.(db.sqlite);

      expect(readProjectPiPolicy(db, "legacy-default")).toMatchObject({
        allowed_supervisor_actions_json: "[\"session.resume_followup\",\"issue.retry_after\",\"issue.retry\",\"needs_user.escalate\"]",
        supervisor_mode: "autonomous"
      });
      expect(readProjectPiPolicy(db, "explicit-off")).toMatchObject({
        allowed_supervisor_actions_json: "[\"session.resume_followup\",\"issue.retry_after\",\"issue.retry\",\"needs_user.escalate\"]",
        supervisor_mode: "autonomous"
      });
    } finally {
      db.close();
    }
  });

  test("migrates legacy databases with supervisor event table and policy columns", async () => {
    const root = await tempPath("codex-runner-supervisor-migrate-");
    const stateDir = join(root, "state");
    await createLegacyDatabase(join(stateDir, "runner.db"));
    await insertLegacyPolicyRow(join(stateDir, "runner.db"));

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
      expect(migrated.sqlite.query(`
        select allowed_supervisor_actions_json, supervisor_mode, supervisor_cooldown_seconds,
          supervisor_max_recoveries_per_issue, supervisor_max_recoveries_per_project_per_hour,
          supervisor_rate_limit_wait_policy
        from project_pi_policies where project_id='legacy-demo'
      `).get()).toEqual({
        allowed_supervisor_actions_json: "[\"session.resume_followup\",\"issue.retry_after\",\"issue.retry\",\"needs_user.escalate\"]",
        supervisor_cooldown_seconds: 300,
        supervisor_max_recoveries_per_issue: 2,
        supervisor_max_recoveries_per_project_per_hour: 10,
        supervisor_mode: "autonomous",
        supervisor_rate_limit_wait_policy: "respect_retry_after"
      });
    } finally {
      migrated.close();
    }
  });

  test("exports reusable fixtures for stream disconnect, 429 variants, human-only failures, and no-progress loops", () => {
    expect(issueSupervisorRecoveryFixtures.map((fixture) => fixture.id)).toEqual([
      "issue-298-stream-disconnect",
      "provider-429-retry-after",
      "provider-429-no-retry-after",
      "provider-401-auth",
      "business-test-failure",
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
    expect(issueSupervisorRecoveryFixtures[2]?.events[0]).toMatchObject({
      diagnosis_code: "provider_rate_limited",
      provider_error_category: "rate_limit"
    });
    expect(issueSupervisorRecoveryFixtures[2]?.events[0]?.retry_after_at).toBeUndefined();
    expect(issueSupervisorRecoveryFixtures[3]?.decisions.at(-1)).toMatchObject({
      decision: "needs_user",
      fallback_if_no_progress: "blocked"
    });
    expect(issueSupervisorRecoveryFixtures[4]?.decisions.at(-1)).toMatchObject({
      decision: "needs_user",
      rationale: expect.stringContaining("test")
    });
    expect(issueSupervisorRecoveryFixtures[5]?.decisions.at(-1)).toMatchObject({
      decision: "needs_user",
      fallback_if_no_progress: "blocked"
    });
  });

  test("redacts supervisor event payloads before persistence and reads", async () => {
    const db = await openFixtureDatabase();
    try {
      const event = createIssueSupervisorEvent(db, {
        event_type: "signal",
        issue_id: 298,
        payload_json: {
          auth_token: "runner-secret",
          cwd: "/Users/xiaobei/private/project",
          nested: { api_key: "sk-live-secret", output_path: "/tmp/raw.log" },
          text: "Authorization: Bearer live-secret"
        },
        project_id: "demo"
      });

      const raw = db.sqlite.query<{ payload_json: string }, [number]>(
        "select payload_json from issue_supervisor_events where id=?"
      ).get(event.id)?.payload_json ?? "";
      const listed = listIssueSupervisorEvents(db, { issueId: 298 })[0]?.payload_json ?? "";
      for (const payload of [raw, listed]) {
        expect(payload).not.toContain("runner-secret");
        expect(payload).not.toContain("sk-live-secret");
        expect(payload).not.toContain("live-secret");
        expect(payload).not.toContain("/Users/xiaobei/private");
        expect(payload).not.toContain("/tmp/raw.log");
        expect(payload).toContain("[redacted]");
        expect(payload).toContain("[redacted-path]");
      }
    } finally {
      db.close();
    }
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

async function insertLegacyPolicyRow(path: string): Promise<void> {
  const db = new Database(path);
  try {
    db.run(`insert into project_pi_policies
      (project_id, default_mode, timezone, working_hours_json, quiet_hours_json,
        retry_policy_json, concurrency_policy_json, verification_policy_json,
        allowed_actions_json, allowed_mcp_capabilities_json, allowed_skill_intents_json,
        created_at, updated_at)
      values ('legacy-demo', 'manual', 'UTC', '{}', '{}',
        '{"enabled":false,"max_attempts":0,"backoff_minutes":[]}',
        '{"max_parallel_issues":1,"max_parallel_pi_cycles":1}',
        '{"pending_timeout_minutes":1440,"on_timeout":"escalate","evidence_required":true}',
        '[]', '[]', '[]', '2026-06-10T00:00:00Z', '2026-06-10T00:00:00Z')`);
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
