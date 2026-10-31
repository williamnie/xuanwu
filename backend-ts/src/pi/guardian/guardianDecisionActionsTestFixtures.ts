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

export const openFixtureDatabase = useTestDatabase();

export function heartbeatActionEvent(db: RunnerDatabase, id: string, issueID: number): void {
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

export function supervisorCandidateEvent(
  db: RunnerDatabase,
  id: string,
  payload: Record<string, unknown>,
  issueID: number,
  actionType: string
): void {
  const selectedAction = {
    action_type: actionType,
    gate_policy: {
      allowed_actions: [actionType],
      authorizedActions: [{
        action_type: actionType,
        issue_id: issueID,
        project_id: "demo"
      }],
      budget_remaining: payload.budget_remaining,
      cooldown_until: payload.cooldown_until,
      mode: "delegated",
      scope: { project_id: "demo" }
    },
    issue_id: issueID,
    payload: {
      decision_id: `pi:${id}`,
      diagnosis_code: payload.diagnosis_code,
      expected_issue_status: "in_progress",
      expected_issue_updated_at: "2026-06-18T00:00:00Z",
      expected_provider_session_id: payload.provider_session_id,
      expected_provider_turn_id: payload.provider_turn_id,
      expected_run_id: `issue-${issueID}-attempt-1`,
      expected_run_status: "in_progress",
      expected_session_status: "running",
      expected_session_updated_at: "2026-06-18T00:00:00Z",
      issue_id: issueID,
      message: actionType === "needs_user.escalate"
        ? needsUserFixtureMessage(issueID, payload)
        : undefined,
      provider: payload.provider,
      provider_session_id: payload.provider_session_id,
      provider_turn_id: payload.provider_turn_id,
      prompt: actionType === "session.resume_followup"
        ? `Continue after PI decision: ${String(payload.reason ?? "")}`
        : undefined,
      reason: payload.reason
    },
    project_id: "demo",
    rationale: payload.reason,
    risk_level: "medium"
  };
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
      ...payload,
      actions: [selectedAction]
    },
    project_id: "demo",
    severity: "watch",
    source: "supervisor",
    source_event_id: id,
    status: "pending"
  });
}

export function needsUserFixtureMessage(issueID: number, payload: Record<string, unknown>): string {
  if (payload.diagnosis_code !== "provider_runtime_unavailable") return String(payload.reason ?? "");
  return "Supervisor 判断 executor provider 当前不可用，无法继续自动恢复。" +
    `provider：${String(payload.provider ?? "unknown")}；issue id：${issueID}；` +
    `诊断码：provider_runtime_unavailable；错误摘要：${String(payload.reason ?? "")}。` +
    "请检查/重启 Codex app-server 或 Claude Code provider 后再 retry。";
}

export function mergeMeta(decision: PiGuardianDecision): Record<string, unknown> {
  const evidence = JSON.parse(decision.evidence_json) as Array<Record<string, unknown>>;
  const row = evidence.find((item) => typeof item.guardian_decision_merge === "object");
  return row?.guardian_decision_merge as Record<string, unknown>;
}
