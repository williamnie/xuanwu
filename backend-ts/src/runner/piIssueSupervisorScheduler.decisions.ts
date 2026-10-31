import type { RunnerDatabase } from "../db/database.ts";
import { createIssueSupervisorEvent, getPiSupervisor } from "../db/repositories/pi.ts";
import { getProject } from "../db/repositories/projects.ts";
import { runPiSupervisorDecision } from "../pi/supervisor/issueSupervisorDecision.ts";
import { ingestPiGuardianEvent } from "../pi/guardian/guardianEventIngest.ts";
import { iso } from "../pi/heartbeat/heartbeatOrchestratorSupport.ts";
import { cleanString, errorMessage } from "../util/values.ts";
import { MAX_INVALID_DECISIONS_PER_EVIDENCE } from "./piIssueSupervisorScheduler.model.ts";
import type { SupervisorTarget, PiIssueSupervisorSchedulerInput, SupervisorDecisionSelection } from "./piIssueSupervisorScheduler.model.ts";
import { invalidDecisionBudgetExhausted, primaryDiagnosis } from "./piIssueSupervisorScheduler.cooldown.ts";

export function recordTarget(
  db: RunnerDatabase,
  target: SupervisorTarget,
  now: Date
): void {
  if (invalidDecisionBudgetExhausted(db, target)) {
    createIssueSupervisorEvent(db, {
      diagnosis_code: primaryDiagnosis(target.context),
      event_type: "decision_failed",
      issue_id: target.issueID,
      payload_json: {
        count: MAX_INVALID_DECISIONS_PER_EVIDENCE,
        message: "PI Supervisor repeatedly returned invalid decisions for the same evidence.",
        outcome: "pi_runtime_retrying",
        report_status: "invalid_decision_retry_boundary"
      },
      project_id: target.projectID,
      provider: cleanString(target.context.session.provider),
      provider_session_id: cleanString(target.context.session.provider_session_id),
      provider_turn_id: cleanString(target.context.session.provider_turn_id),
      run_id: cleanString(target.context.latest_run?.id)
    });
  }
  recordSignal(db, target, now);
}

export function recordSignal(db: RunnerDatabase, target: SupervisorTarget, now: Date): void {
  const candidate = target.candidates[0];
  createIssueSupervisorEvent(db, {
    diagnosis_code: cleanString(candidate?.diagnosis_code),
    event_type: "signal",
    issue_id: target.issueID,
    payload_json: { candidate, candidates: target.candidates },
    project_id: target.projectID,
    provider: cleanString(target.context.session.provider) || cleanString(target.context.provider_error?.provider),
    provider_error_category: cleanString(target.context.provider_error?.category),
    provider_session_id: cleanString(target.context.session.provider_session_id),
    provider_turn_id: cleanString(target.context.session.provider_turn_id),
    retry_after_at: cleanString(candidate?.wait_until),
    run_id: cleanString(target.context.latest_run?.id)
  });
}

export async function decideTarget(
  input: PiIssueSupervisorSchedulerInput,
  target: SupervisorTarget,
  now: Date
): Promise<SupervisorDecisionSelection> {
  if (input.runDecision) return input.runDecision(target.context);
  const agent = getPiSupervisor(input.database);
  if (!agent || agent.enabled !== 1) throw new Error("PI Supervisor Agent is missing or disabled");
  const project = getProject(input.database, target.projectID);
  if (!project) throw new Error(`PI Supervisor project is unavailable: ${target.projectID}`);
  return runPiSupervisorDecision({
    agent,
    context: target.context,
    database: input.database,
    now,
    project
  });
}

export function recordFailure(db: RunnerDatabase, target: SupervisorTarget, error: unknown, now: Date): void {
  const message = `PI Supervisor unavailable for issue #${target.issueID}: ${errorMessage(error)}`;
  createIssueSupervisorEvent(db, {
    decision: "pi_runtime_failed",
    diagnosis_code: primaryDiagnosis(target.context),
    event_type: "decision_failed",
    issue_id: target.issueID,
    payload_json: {
      error: errorMessage(error),
      recovery_message: message,
      supervisor_agent: { runnable: false, source: "pi_supervisor_runtime" }
    },
    project_id: target.projectID,
    provider: cleanString(target.context.session.provider) || cleanString(target.context.provider_error?.provider),
    provider_error_category: cleanString(target.context.provider_error?.category),
    provider_session_id: cleanString(target.context.session.provider_session_id),
    provider_turn_id: cleanString(target.context.session.provider_turn_id),
    run_id: cleanString(target.context.latest_run?.id)
  });
  ingestPiGuardianEvent(db, {
    eventType: "guardian.pi_supervisor.unavailable",
    idempotencyKey: `pi-supervisor-unavailable:${target.projectID}:${target.issueID}:${primaryDiagnosis(target.context)}`,
    issueID: target.issueID,
    normalizedPayload: {
      diagnosis_code: "pi_supervisor_unavailable",
      message,
      requires_user: false
    },
    projectID: target.projectID,
    severity: "watch",
    source: "pi_supervisor",
    sourceEventID: `supervisor:${target.projectID}:${target.issueID}:${iso(now)}`,
    status: "pending"
  });
}
