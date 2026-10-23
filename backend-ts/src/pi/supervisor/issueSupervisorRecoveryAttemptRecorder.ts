import { recordPiRecoveryAttempt } from "../../db/repositories/pi/recoveryAttempts.ts";
import type { PiAction } from "../../db/repositories/pi.ts";
import type { IssueSupervisorRecoveryContext } from "./issueSupervisorContext.ts";
import type { IssueSupervisorActionInput } from "./issueSupervisorActions.ts";
import type { ProgressSnapshot } from "./meaningfulProgress.ts";
import { cleanString, objectValue } from "../../util/values.ts";

const RECOVERY_ATTEMPT_ACTIONS = new Set(["session.steer"]);
const RECOVERY_HARD_TIMEOUT_MS = 5 * 60_000;

export function recordSupervisorRecoveryAttempt(
  input: IssueSupervisorActionInput,
  action: PiAction
): void {
  if (!RECOVERY_ATTEMPT_ACTIONS.has(action.action_type)) return;
  const now = input.now ?? new Date();
  const payload = objectValue(parseJson(action.payload_json));
  recordPiRecoveryAttempt(input.database, {
    action_type: action.action_type,
    before_snapshot_json: recoverySnapshot(input.context),
    budget_window_started_at: now.toISOString(),
    diagnosis_code: primaryDiagnosis(input.context) || "session_no_recent_progress",
    executing_started_at: now.toISOString(),
    expected_provider_turn_id: cleanString(payload.expected_provider_turn_id) || cleanString(input.context.latest_run?.provider_turn_id),
    hard_timeout_at: new Date(now.getTime() + RECOVERY_HARD_TIMEOUT_MS).toISOString(),
    id: `recovery-${action.id}`,
    idempotency_key: `recovery:${action.id}`,
    issue_id: action.issue_id,
    project_id: action.project_id,
    provider_session_id: cleanString(input.context.session.provider_session_id),
    provider_turn_id: cleanString(input.context.session.provider_turn_id),
    run_id: cleanString(input.context.latest_run?.id),
    session_id: sessionKey(input.context),
    source_decision_id: action.id,
    status: "executing"
  });
}

function recoverySnapshot(context: IssueSupervisorRecoveryContext): ProgressSnapshot {
  return {
    git_diff_hash: cleanString(context.workspace_snapshot.git_diff_hash),
    issue: { status: cleanString(context.issue.status), updated_at: cleanString(context.issue.updated_at) },
    run: {
      status: cleanString(context.latest_run?.status),
      updated_at: cleanString(context.latest_run?.ended_at) || cleanString(context.latest_run?.started_at)
    },
    session: {
      status: cleanString(context.session.raw_status) || cleanString(context.session.status),
      updated_at: cleanString(context.session.updated_at)
    }
  };
}

function primaryDiagnosis(context: IssueSupervisorRecoveryContext): string {
  return cleanString(context.candidates[0]?.diagnosis_code) || cleanString(context.provider_error?.diagnosis_code);
}

function sessionKey(context: IssueSupervisorRecoveryContext): string {
  const provider = cleanString(context.session.provider) || cleanString(context.provider_error?.provider);
  const sessionID = cleanString(context.session.provider_session_id);
  return provider !== "" && sessionID !== "" ? `${provider}:${sessionID}` : "";
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value || "{}") as unknown; } catch { return {}; }
}
