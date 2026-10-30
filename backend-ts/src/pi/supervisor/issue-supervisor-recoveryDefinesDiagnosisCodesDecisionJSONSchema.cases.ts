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
  readProjectPiPolicy,
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

export function registerDefinesDiagnosisCodesDecisionJSONSchema() {
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
      "repair_issue_state",
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
      "issue.state_repair",
      "issue.supervisor_decision",
      "needs_user.escalate",
      "session.resume_followup",
      "session.steer"
    ]);
    expect(PI_SUPERVISOR_DECISION_ACTION_TYPES.resume_session).toEqual(["session.resume_followup"]);
    expect(PI_SUPERVISOR_DECISION_ACTION_TYPES.repair_issue_state).toEqual(["issue.state_repair"]);
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

test("extends project policy with allowed actions, cooldown, budget, and 429 wait policy", async () => {
    const db = await openFixtureDatabase();
    expect(readProjectPiPolicy(db, "demo")).toMatchObject({
      allowed_supervisor_actions_json: "[\"session.resume_followup\",\"issue.retry_after\",\"issue.retry\",\"issue.state_repair\",\"needs_user.escalate\"]",
      supervisor_cooldown_seconds: 300,
      supervisor_max_recoveries_per_issue: 6,
      supervisor_max_recoveries_per_project_per_hour: 0,
      supervisor_rate_limit_wait_policy: "respect_retry_after"
    });

    const policy = upsertProjectPiPolicy(db, {
      allowed_supervisor_actions_json: ["session.resume_followup", "issue.retry_after"],
      project_id: "demo",
      supervisor_cooldown_seconds: 900,
      supervisor_max_recoveries_per_issue: 3,
      supervisor_max_recoveries_per_project_per_hour: 12,
      supervisor_rate_limit_wait_policy: "ask"
    });

    expect(policy).toMatchObject({
      supervisor_cooldown_seconds: 900,
      supervisor_max_recoveries_per_issue: 3,
      supervisor_max_recoveries_per_project_per_hour: 0,
      supervisor_rate_limit_wait_policy: "ask"
    });
    expect(JSON.parse(policy.allowed_supervisor_actions_json)).toEqual([
      "session.resume_followup",
      "issue.retry_after"
    ]);
  });

test("persists a signal to decision to action to result supervisor event chain", async () => {
    const db = await openFixtureDatabase();
    createIssueSupervisorEvent(db, {
      diagnosis_code: "executor_stream_disconnected",
      event_type: "signal",
      issue_id: 298,
      payload_json: { summary: "Reconnecting... 1/5" },
      project_id: "xuanwu",
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
      project_id: "xuanwu"
    });
    createIssueSupervisorEvent(db, {
      action_id: "pi-action-298-resume",
      action_type: "session.resume_followup",
      decision: "resume_session",
      event_type: "action",
      issue_id: 298,
      payload_json: { prompt: "continue after inspecting current state" },
      project_id: "xuanwu"
    });
    createIssueSupervisorEvent(db, {
      action_id: "pi-action-298-resume",
      decision: "resume_session",
      event_type: "result",
      issue_id: 298,
      payload_json: { outcome: "progress" },
      project_id: "xuanwu"
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
  });
}
