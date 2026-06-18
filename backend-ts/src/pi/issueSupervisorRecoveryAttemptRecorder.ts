import { recordPiRecoveryAttempt } from "../db/repositories/pi/recoveryAttempts.ts";
import type { PiAction } from "../db/repositories/pi.ts";
import type { IssueSupervisorRecoveryContext } from "./issueSupervisorContext.ts";
import type { IssueSupervisorActionInput } from "./issueSupervisorActions.ts";
import type { ProgressSnapshot } from "./meaningfulProgress.ts";

const RECOVERY_ATTEMPT_ACTIONS = new Set(["session.resume_followup", "session.steer"]);
const RECOVERY_HARD_TIMEOUT_MS = 5 * 60_000;

export function recordSupervisorRecoveryAttempt(
  input: IssueSupervisorActionInput,
  action: PiAction
): void {
  if (!RECOVERY_ATTEMPT_ACTIONS.has(action.action_type)) return;
  const now = input.now ?? new Date();
  const payload = objectPayload(parseJson(action.payload_json));
  recordPiRecoveryAttempt(input.database, {
    action_type: action.action_type,
    before_snapshot_json: recoverySnapshot(input.context),
    budget_window_started_at: now.toISOString(),
    diagnosis_code: primaryDiagnosis(input.context) || "session_no_recent_progress",
    executing_started_at: now.toISOString(),
    expected_provider_turn_id: clean(payload.expected_provider_turn_id) || clean(input.context.latest_run?.provider_turn_id),
    hard_timeout_at: new Date(now.getTime() + RECOVERY_HARD_TIMEOUT_MS).toISOString(),
    id: `recovery-${action.id}`,
    idempotency_key: `recovery:${action.id}`,
    issue_id: action.issue_id,
    project_id: action.project_id,
    provider_session_id: clean(input.context.session.provider_session_id),
    provider_turn_id: clean(input.context.session.provider_turn_id),
    run_id: clean(input.context.latest_run?.id),
    session_id: sessionKey(input.context),
    source_decision_id: action.id,
    status: "executing"
  });
}

function recoverySnapshot(context: IssueSupervisorRecoveryContext): ProgressSnapshot {
  return {
    git_diff_hash: clean(context.workspace_snapshot.git_diff_hash),
    issue: { status: clean(context.issue.status), updated_at: clean(context.issue.updated_at) },
    run: {
      status: clean(context.latest_run?.status),
      updated_at: clean(context.latest_run?.ended_at) || clean(context.latest_run?.started_at)
    },
    session: {
      status: clean(context.session.raw_status) || clean(context.session.status),
      updated_at: clean(context.session.updated_at)
    }
  };
}

function primaryDiagnosis(context: IssueSupervisorRecoveryContext): string {
  return clean(context.candidates[0]?.diagnosis_code) || clean(context.provider_error?.diagnosis_code);
}

function sessionKey(context: IssueSupervisorRecoveryContext): string {
  const provider = clean(context.session.provider) || clean(context.provider_error?.provider);
  const sessionID = clean(context.session.provider_session_id);
  return provider !== "" && sessionID !== "" ? `${provider}:${sessionID}` : "";
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value || "{}") as unknown; } catch { return {}; }
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
