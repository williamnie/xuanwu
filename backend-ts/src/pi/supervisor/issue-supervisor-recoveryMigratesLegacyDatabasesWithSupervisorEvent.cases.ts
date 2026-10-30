import { afterEach, describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { runMigrations } from "../../db/migrations.ts";
import { migrations } from "../../db/schema/index.ts";
import {
  createIssueSupervisorEvent,
  listIssueSupervisorEvents,
  type readProjectPiPolicy,
  upsertProjectPiPolicy
} from "../../db/repositories/pi.ts";
import { classifyPiActionRisk } from "../actions/actionGate.ts";
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
import { useDatabaseCleanup } from "../../testing/harness.ts";

import { trackDatabase, tempRoots, openFixtureDatabase, tempPath, createLegacyDatabase, insertLegacyPolicyRow, supervisorMigrationIndex, tableNames, columnNames } from "./issue-supervisor-recoveryTestFixtures.ts";

export function registerMigratesLegacyDatabasesWithSupervisorEvent() {
test("migrates legacy databases with supervisor event table and policy columns", async () => {
    const root = await tempPath("xuanwu-supervisor-migrate-");
    const stateDir = join(root, "state");
    await createLegacyDatabase(join(stateDir, "runner.db"));
    await insertLegacyPolicyRow(join(stateDir, "runner.db"));

    const migrated = await openDatabase({ stateDir }).then(trackDatabase);
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
      "supervisor_rate_limit_wait_policy"
    ]));
    expect(migrated.sqlite.query("select id from schema_migrations where id='020_issue_supervisor_recovery'").get())
      .toEqual({ id: "020_issue_supervisor_recovery" });
    expect(migrated.sqlite.query(`
        select allowed_supervisor_actions_json, supervisor_cooldown_seconds,
          supervisor_max_recoveries_per_issue, supervisor_max_recoveries_per_project_per_hour,
          supervisor_rate_limit_wait_policy
        from project_pi_policies where project_id='legacy-demo'
      `).get()).toEqual({
      allowed_supervisor_actions_json: "[\"session.resume_followup\",\"issue.retry_after\",\"issue.retry\",\"issue.state_repair\",\"needs_user.escalate\"]",
      supervisor_cooldown_seconds: 300,
      supervisor_max_recoveries_per_issue: 6,
      supervisor_max_recoveries_per_project_per_hour: 0,
      supervisor_rate_limit_wait_policy: "respect_retry_after"
    });
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
  });

test("classifies new supervisor action types with stable gate risk", () => {
    expect(classifyPiActionRisk("issue.supervisor_decision")).toMatchObject({ gate: "safe", riskLevel: "low" });
    expect(classifyPiActionRisk("issue.retry_after")).toMatchObject({ gate: "safe", riskLevel: "low" });
    expect(classifyPiActionRisk("session.resume_followup")).toMatchObject({ gate: "confirm", riskLevel: "medium" });
  });
}
