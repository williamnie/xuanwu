import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import {
  createPiAction,
  createPiGuardianEvent,
  listPiActions,
  listPiGuardianDecisions,
  type PiGuardianDecision
} from "../db/repositories/pi.ts";
import { runGuardianDecisionOrchestratorOnce } from "./guardianDecisionOrchestrator.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI Guardian decision action outlet", () => {
  test("creates one gated PI action for duplicate heartbeat action candidates", async () => {
    const db = await openFixtureDatabase();
    try {
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
    } finally {
      db.close();
    }
  });

  test("skips action creation while the same guardian action lease is held", async () => {
    const db = await openFixtureDatabase();
    try {
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
    } finally {
      db.close();
    }
  });

  test("turns transient supervisor candidates into gated recovery actions after merge window", async () => {
    const db = await openFixtureDatabase();
    try {
      supervisorCandidateEvent(db, "supervisor-transient", {
        allowed_actions: ["session.resume_followup"],
        budget_remaining: 1,
        diagnosis_code: "provider_timeout",
        provider: "codex",
        provider_session_id: "thread-601",
        provider_turn_id: "turn-old",
        reason: "provider timed out after stream stall",
        supervisor_mode: "autonomous"
      }, 601);

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
    } finally {
      db.close();
    }
  });

  test("routes needs-context supervisor candidates to needs-user escalation actions", async () => {
    const db = await openFixtureDatabase();
    try {
      supervisorCandidateEvent(db, "supervisor-needs-context", {
        allowed_actions: ["needs_user.escalate"],
        budget_remaining: 1,
        diagnosis_code: "missing_user_input",
        reason: "agent needs the missing production tenant name",
        supervisor_mode: "autonomous"
      }, 602);

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
    } finally {
      db.close();
    }
  });

  test("lets recovery gate deny exhausted budget and snooze cooldown candidates", async () => {
    const db = await openFixtureDatabase();
    try {
      supervisorCandidateEvent(db, "supervisor-budget-exhausted", {
        allowed_actions: ["session.resume_followup"],
        budget_remaining: 0,
        diagnosis_code: "provider_timeout",
        provider: "codex",
        provider_session_id: "thread-603",
        provider_turn_id: "turn-old",
        reason: "provider timed out",
        supervisor_mode: "autonomous"
      }, 603);
      supervisorCandidateEvent(db, "supervisor-cooldown", {
        allowed_actions: ["session.resume_followup"],
        budget_remaining: 1,
        cooldown_until: "2026-06-18T00:05:00Z",
        diagnosis_code: "provider_timeout",
        provider: "codex",
        provider_session_id: "thread-604",
        provider_turn_id: "turn-old",
        reason: "provider timed out",
        supervisor_mode: "autonomous"
      }, 604);

      runGuardianDecisionOrchestratorOnce(db, { now: new Date("2026-06-18T00:02:00Z") });
      runGuardianDecisionOrchestratorOnce(db, { now: new Date("2026-06-18T00:02:31Z") });

      expect(listPiActions(db, { issueId: 603 })[0]).toMatchObject({
        action_type: "session.resume_followup",
        gate_decision: "deny",
        gate_reason: expect.stringContaining("budget"),
        status: "denied"
      });
      expect(listPiActions(db, { issueId: 604 })[0]).toMatchObject({
        action_type: "session.resume_followup",
        gate_decision: "snooze",
        gate_reason: expect.stringContaining("cooldown"),
        status: "snoozed"
      });
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-guardian-decision-actions-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function heartbeatActionEvent(db: RunnerDatabase, id: string, issueID: number): void {
  createPiGuardianEvent(db, {
    event_type: "guardian.heartbeat.action_candidate",
    id,
    idempotency_key: `guardian.heartbeat.action_candidate:demo:${issueID}:issue.enqueue:${id}`,
    issue_id: issueID,
    normalized_payload_json: {
      action_type: "issue.enqueue",
      diagnosis_code: "issue.enqueue",
      original_payload: { issue_id: issueID },
      rationale: "todo issue has no active session",
      risk_level: "medium",
      signal_type: "heartbeat.action_candidate"
    },
    project_id: "demo",
    severity: "watch",
    source: "heartbeat",
    source_event_id: id,
    status: "pending"
  });
}

function supervisorCandidateEvent(
  db: RunnerDatabase,
  id: string,
  payload: Record<string, unknown>,
  issueID: number
): void {
  createPiGuardianEvent(db, {
    event_type: "guardian.supervisor.candidate",
    id,
    idempotency_key: `guardian.supervisor.candidate:demo:${issueID}:${id}`,
    issue_id: issueID,
    normalized_payload_json: {
      issue_status: "in_progress",
      issue_updated_at: "2026-06-18T00:00:00Z",
      project_id: "demo",
      ready: true,
      run_id: `issue-${issueID}-attempt-1`,
      run_status: "in_progress",
      session_status: "running",
      session_updated_at: "2026-06-18T00:00:00Z",
      signal_type: "supervisor.candidate",
      ...payload
    },
    project_id: "demo",
    severity: "watch",
    source: "supervisor",
    source_event_id: id,
    status: "pending"
  });
}

function mergeMeta(decision: PiGuardianDecision): Record<string, unknown> {
  const evidence = JSON.parse(decision.evidence_json) as Array<Record<string, unknown>>;
  const row = evidence.find((item) => typeof item.guardian_decision_merge === "object");
  return row?.guardian_decision_merge as Record<string, unknown>;
}
