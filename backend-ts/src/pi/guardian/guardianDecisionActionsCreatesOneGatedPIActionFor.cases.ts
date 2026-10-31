import { describe, expect, test } from "bun:test";
import { type RunnerDatabase } from "../../db/database.ts";
import {
  createPiAction,
  createPiGuardianEvent,
  listPiActions,
  listPiGuardianDecisions,
  type PiGuardianDecision
} from "../../db/repositories/pi.ts";
import { runGuardianDecisionOrchestratorOnce } from "./guardianDecisionOrchestrator.ts";
import { useTestDatabase } from "../../testing/harness.ts";

import { openFixtureDatabase, heartbeatActionEvent, supervisorCandidateEvent, needsUserFixtureMessage, mergeMeta } from "./guardianDecisionActionsTestFixtures.ts";

export function registerCreatesOneGatedPIActionFor() {
test("creates one gated PI action for duplicate heartbeat action candidates", async () => {
    const db = await openFixtureDatabase();
    heartbeatActionEvent(db, "heartbeat-action-1", 501);
    heartbeatActionEvent(db, "heartbeat-action-2", 501);

    const summary = runGuardianDecisionOrchestratorOnce(db, {
      now: new Date("2026-06-18T00:03:00Z")
    });
    const [decision] = listPiGuardianDecisions(db, { decisionKind: "recovery", issueId: 501, projectId: "demo" });

    expect(summary).toMatchObject({ created: 1, lease_skipped: 0, merged: 1, scanned: 2 });
    expect(decision).toMatchObject({ state: "proposed" });
    expect(mergeMeta(decision)).toMatchObject({
      base_key: "recovery:demo:issue:501:issue.enqueue",
      event_count: 2
    });
    expect(listPiActions(db, { issueId: 501 })).toHaveLength(0);

    const settled = runGuardianDecisionOrchestratorOnce(db, {
      now: new Date("2026-06-18T00:03:31Z")
    });

    expect(settled).toMatchObject({ leases_acquired: 1, scanned: 0 });
    expect(listPiActions(db, { issueId: 501 })[0]).toMatchObject({
      action_type: "issue.enqueue",
      gate_decision: "ask",
      guardian_decision_id: decision.id,
      legacy_bypass_reason: "",
      status: "pending"
    });
    expect(listPiGuardianDecisions(db, { decisionKind: "recovery", issueId: 501, projectId: "demo" })[0])
      .toMatchObject({ state: "completed" });
  });

test("skips action creation while the same guardian action lease is held", async () => {
    const db = await openFixtureDatabase();
    createPiAction(db, {
      action_type: "issue.enqueue",
      id: "held-guardian-action",
      issue_id: 502,
      lease_expires_at: "2026-06-18T00:09:00Z",
      lease_key: "demo:issue:502:issue.enqueue",
      project_id: "demo",
      status: "executing"
    });
    heartbeatActionEvent(db, "heartbeat-action-held-2", 502);
    const queued = runGuardianDecisionOrchestratorOnce(db, { now: new Date("2026-06-18T00:04:10Z") });
    const summary = runGuardianDecisionOrchestratorOnce(db, { now: new Date("2026-06-18T00:04:41Z") });
    const decisions = listPiGuardianDecisions(db, { decisionKind: "recovery", issueId: 502, projectId: "demo" });

    expect(queued).toMatchObject({ created: 1, scanned: 1 });
    expect(summary).toMatchObject({ lease_skipped: 1, leases_acquired: 0, scanned: 0 });
    expect(listPiActions(db, { issueId: 502 }).map((action) => action.id)).toEqual(["held-guardian-action"]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ rationale: "lease_held", state: "skipped" });
  });

test("turns transient supervisor candidates into gated recovery actions after merge window", async () => {
    const db = await openFixtureDatabase();
    supervisorCandidateEvent(db, "supervisor-transient", {
      allowed_actions: ["session.resume_followup"],
      budget_remaining: 1,
      diagnosis_code: "provider_timeout",
      provider: "codex",
      provider_session_id: "thread-601",
      provider_turn_id: "turn-old",
      reason: "provider timed out after stream stall",
    }, 601, "session.resume_followup");

    runGuardianDecisionOrchestratorOnce(db, { now: new Date("2026-06-18T00:00:00Z") });
    const settled = runGuardianDecisionOrchestratorOnce(db, { now: new Date("2026-06-18T00:00:31Z") });
    const [action] = listPiActions(db, { issueId: 601 });

    expect(settled).toMatchObject({ leases_acquired: 1, scanned: 0 });
    expect(action).toMatchObject({
      action_type: "session.resume_followup",
      gate_decision: "execute",
      guardian_decision_id: expect.stringContaining("recovery:demo:issue:601:provider_timeout"),
      status: "approved"
    });
    expect(JSON.parse(action?.payload_json ?? "{}")).toMatchObject({
      expected_provider_turn_id: "turn-old",
      expected_run_id: "issue-601-attempt-1",
      expected_session_updated_at: "2026-06-18T00:00:00Z",
      issue_id: 601,
      provider_session_id: "thread-601"
    });
  });

test("automatically approves a fresh issue retry for a transient startup timeout", async () => {
    const db = await openFixtureDatabase();
    supervisorCandidateEvent(db, "supervisor-startup-timeout", {
      allowed_actions: ["issue.retry", "needs_user.escalate"],
      budget_remaining: 2,
      diagnosis_code: "provider_transient_network_error",
      provider: "codex",
      provider_error_category: "network",
      reason: "codex app-server request timed out after 90000ms: thread/start",
      session_status: "unknown",
    }, 670, "issue.retry");

    runGuardianDecisionOrchestratorOnce(db, { now: new Date("2026-06-18T00:01:00Z") });
    runGuardianDecisionOrchestratorOnce(db, { now: new Date("2026-06-18T00:01:31Z") });
    const [action] = listPiActions(db, { issueId: 670 });

    expect(action).toMatchObject({
      action_type: "issue.retry",
      gate_decision: "execute",
      status: "approved"
    });
    expect(JSON.parse(action?.payload_json ?? "{}")).toMatchObject({
      diagnosis_code: "provider_transient_network_error",
      issue_id: 670,
      provider: "codex"
    });
  });

test("routes needs-context supervisor candidates to needs-user escalation actions", async () => {
    const db = await openFixtureDatabase();
    supervisorCandidateEvent(db, "supervisor-needs-context", {
      allowed_actions: ["needs_user.escalate"],
      budget_remaining: 1,
      diagnosis_code: "missing_user_input",
      reason: "agent needs the missing production tenant name",
    }, 602, "needs_user.escalate");

    const queued = runGuardianDecisionOrchestratorOnce(db, { now: new Date("2026-06-18T00:01:00Z") });
    const summary = runGuardianDecisionOrchestratorOnce(db, { now: new Date("2026-06-18T00:01:31Z") });
    const [action] = listPiActions(db, { issueId: 602 });

    expect(queued).toMatchObject({ created: 1, scanned: 1 });
    expect(summary).toMatchObject({ leases_acquired: 1, scanned: 0 });
    expect(action).toMatchObject({
      action_type: "needs_user.escalate",
      gate_decision: "execute",
      status: "approved"
    });
    expect(JSON.parse(action?.payload_json ?? "{}")).toMatchObject({
      diagnosis_code: "missing_user_input",
      issue_id: 602,
      message: expect.stringContaining("missing production tenant")
    });
  });

test("routes provider runtime unavailable through gate as needs-user escalation", async () => {
    const db = await openFixtureDatabase();
    supervisorCandidateEvent(db, "supervisor-provider-outage", {
      allowed_actions: ["session.resume_followup"],
      budget_remaining: 0,
      cooldown_until: "2026-06-18T00:10:00Z",
      diagnosis_code: "provider_runtime_unavailable",
      provider: "claude",
      reason: "latest provider error has no recoverable provider session",
    }, 605, "needs_user.escalate");

    runGuardianDecisionOrchestratorOnce(db, { now: new Date("2026-06-18T00:02:00Z") });
    runGuardianDecisionOrchestratorOnce(db, { now: new Date("2026-06-18T00:02:31Z") });
    const actions = listPiActions(db, { issueId: 605 });
    const payload = JSON.parse(actions[0]?.payload_json ?? "{}");

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ action_type: "needs_user.escalate", gate_decision: "execute", status: "approved" });
    expect(payload.message).toContain("provider：claude");
    expect(payload.message).toContain("issue id：605");
    expect(payload.message).toContain("诊断码：provider_runtime_unavailable");
    expect(payload.message).toContain("错误摘要：latest provider error has no recoverable provider session");
    expect(payload.message).toContain("请检查/重启 Codex app-server 或 Claude Code provider 后再 retry");
  });
}
