import type { RunnerDatabase } from "../db/database.ts";
import type { PiGuardianEvent } from "../db/repositories/pi.ts";
import { ingestPiGuardianEvent } from "./guardianEventIngest.ts";
import type { HeartbeatActionCandidate, HeartbeatSupervisorCandidateSignal } from "./heartbeatTypes.ts";
import {
  classifyGuardianFailure,
  type GuardianFailureClassification,
  type GuardianSignalSeverity
} from "./guardianFailureClassifier.ts";
import { cleanString, isoSeconds, positiveInteger } from "../util/values.ts";

type GuardianSignalSource = "heartbeat" | "supervisor";
type GuardianSignal = {
  action_type: string;
  classification?: GuardianFailureClassification;
  diagnosis_code?: string;
  event_type: string;
  idempotency_key: string;
  issue_id: number;
  payload: Record<string, unknown>;
  project_id: string;
  severity: GuardianSignalSeverity;
  source: GuardianSignalSource;
  source_event_id: string;
};
type GuardianSignalWriteSummary = {
  action_id: string;
  action_type: string;
  event_id: string;
  issue_id: number;
  signal_id: string;
  status: "signaled";
};
type GuardianSignalContext = { heartbeatID?: string; now: Date; projectID: string };

export function guardianSignalsFromHeartbeatActions(
  actions: HeartbeatActionCandidate[],
  context: GuardianSignalContext
): GuardianSignal[] {
  return actions.map((action) => heartbeatActionSignal(action, context));
}

export function guardianSignalsFromSupervisorCandidates(
  candidates: HeartbeatSupervisorCandidateSignal[],
  context: GuardianSignalContext
): GuardianSignal[] {
  return candidates.map((candidate) => supervisorCandidateSignal(candidate, context));
}

export function writeGuardianSignals(db: RunnerDatabase, signals: GuardianSignal[]): GuardianSignalWriteSummary[] {
  return signals.map((signal) => summaryFromEvent(signal, writeGuardianSignal(db, signal)));
}

function writeGuardianSignal(db: RunnerDatabase, signal: GuardianSignal): PiGuardianEvent {
  return ingestPiGuardianEvent(db, {
    eventType: signal.event_type,
    idempotencyKey: signal.idempotency_key,
    issueID: signal.issue_id,
    normalizedPayload: normalizedPayload(signal),
    projectID: signal.project_id,
    severity: signal.severity,
    source: signal.source,
    sourceEventID: signal.source_event_id,
    status: "pending"
  });
}

function heartbeatActionSignal(action: HeartbeatActionCandidate, context: GuardianSignalContext): GuardianSignal {
  const projectID = cleanString(action.project_id) || context.projectID;
  const issueID = positiveInteger(action.issue_id) || positiveInteger(action.payload.issue_id);
  const classification = classifyGuardianFailure({
    diagnosisCode: cleanString(action.payload.diagnosis_code),
    message: `${action.rationale} ${cleanString(action.payload.reason)}`,
    status: cleanString(action.payload.status)
  });
  const severity = heartbeatActionSeverity(action.action_type, classification.severity);
  return {
    action_type: "heartbeat.action_candidate",
    classification: { ...classification, severity },
    diagnosis_code: cleanString(action.payload.diagnosis_code) || action.action_type,
    event_type: "guardian.heartbeat.action_candidate",
    idempotency_key: ["guardian.heartbeat.action_candidate", projectID, issueID, action.action_type, sourceID(context)].join(":"),
    issue_id: issueID,
    payload: {
      action_type: action.action_type,
      diagnosis_code: cleanString(action.payload.diagnosis_code) || action.action_type,
      original_payload: action.payload,
      rationale: action.rationale,
      risk_level: action.risk_level,
      signal_type: "heartbeat.action_candidate"
    },
    project_id: projectID,
    severity,
    source: "heartbeat",
    source_event_id: sourceID(context)
  };
}

function supervisorCandidateSignal(
  candidate: HeartbeatSupervisorCandidateSignal,
  context: GuardianSignalContext
): GuardianSignal {
  const projectID = cleanString(candidate.project_id) || context.projectID;
  const issueID = positiveInteger(candidate.issue_id);
  const classification = classifyGuardianFailure({
    diagnosisCode: candidate.diagnosis_code,
    message: candidate.reason,
    providerErrorCategory: candidate.provider_error_category
  });
  return {
    action_type: "supervisor.candidate",
    classification,
    diagnosis_code: candidate.diagnosis_code,
    event_type: "guardian.supervisor.candidate",
    idempotency_key: ["guardian.supervisor.candidate", projectID, issueID, candidate.diagnosis_code, sourceID(context)].join(":"),
    issue_id: issueID,
    payload: {
      ...candidate,
      classification,
      signal_type: "supervisor.candidate"
    },
    project_id: projectID,
    severity: classification.severity,
    source: "supervisor",
    source_event_id: sourceID(context)
  };
}

function normalizedPayload(signal: GuardianSignal): Record<string, unknown> {
  return {
    ...signal.payload,
    classification: signal.classification,
    diagnosis_code: signal.diagnosis_code ?? "",
    guardian_signal: true,
    severity: signal.severity,
    source: signal.source
  };
}

function summaryFromEvent(signal: GuardianSignal, event: PiGuardianEvent): GuardianSignalWriteSummary {
  return {
    action_id: event.id,
    action_type: signal.action_type,
    event_id: event.id,
    issue_id: signal.issue_id,
    signal_id: event.id,
    status: "signaled"
  };
}

function heartbeatActionSeverity(actionType: string, fallback: GuardianSignalSeverity): GuardianSignalSeverity {
  if (actionType === "needs_user.escalate") return "actionable";
  if (actionType === "issue.enqueue" || actionType === "issue.retry_proposal") return "watch";
  return fallback === "info" ? "watch" : fallback;
}

function sourceID(context: GuardianSignalContext): string {
  return cleanString(context.heartbeatID) || `guardian-signal:${context.projectID}:${isoSeconds(context.now)}`;
}
