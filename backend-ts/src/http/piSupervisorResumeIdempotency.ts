import type { RunnerDatabase } from "../db/database.ts";
import { getAgentSession, upsertAgentSession } from "../db/repositories/agentSessions.ts";
import { updateIssueRuntime } from "../db/repositories/issueRuns.ts";
import type { PiAction } from "../db/repositories/pi.ts";
import {
  listPiRecoveryAttemptsForResumeTurn,
  recordPiRecoveryAttempt,
  updatePiRecoveryAttemptStatus,
  type PiRecoveryAttempt
} from "../db/repositories/pi/recoveryAttempts.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";

export type ResumeAttemptPreparation =
  | { attempt: PiRecoveryAttempt; skip: false }
  | ResumeAttemptSkip;
export type ResumeAttemptSkip = { result: Record<string, unknown>; skip: true };

export type ResumeAttemptInput = {
  action: PiAction;
  issueID: number;
  payload: Record<string, unknown>;
  provider: ExecutorProvider;
  providerID: ExecutorProviderId;
  sessionID: string;
};

type PrepareState = {
  createWhenReady: boolean;
  expectedTurnID: string;
  observedTurnID: string;
};
type SkipInput = { attempt: PiRecoveryAttempt; outcome: string; turnID: string };

const HARD_TIMEOUT_MS = 5 * 60_000;

export async function resolveResumeFollowupReplay(
  db: RunnerDatabase,
  input: ResumeAttemptInput
): Promise<ResumeAttemptSkip | null> {
  const expectedTurnID = requiredText(input.payload.expected_provider_turn_id, "expected_provider_turn_id");
  const observedTurnID = await observedProviderTurnID(db, input.provider, input.providerID, input.sessionID);
  return db.transaction(() => prepareInTransaction(db, input, {
    createWhenReady: false, expectedTurnID, observedTurnID
  })).immediate() as ResumeAttemptSkip | null;
}

export async function prepareResumeFollowupAttempt(
  db: RunnerDatabase,
  input: ResumeAttemptInput
): Promise<ResumeAttemptPreparation> {
  const expectedTurnID = requiredText(input.payload.expected_provider_turn_id, "expected_provider_turn_id");
  const observedTurnID = await observedProviderTurnID(db, input.provider, input.providerID, input.sessionID);
  const prepared = db.transaction(() => prepareInTransaction(db, input, {
    createWhenReady: true, expectedTurnID, observedTurnID
  })).immediate();
  if (!prepared) throw new Error("resume attempt was not prepared");
  return prepared;
}

export function markResumeFollowupAttemptStarted(
  db: RunnerDatabase,
  attemptID: string,
  resultTurnID: string
): PiRecoveryAttempt {
  return updatePiRecoveryAttemptStatus(db, attemptID, {
    result_provider_turn_id: resultTurnID,
    status: "executing"
  });
}

function prepareInTransaction(
  db: RunnerDatabase,
  input: ResumeAttemptInput,
  state: PrepareState
): ResumeAttemptPreparation | null {
  const attempts = listPiRecoveryAttemptsForResumeTurn(db, {
    expectedProviderTurnID: state.expectedTurnID,
    issueID: input.issueID,
    providerSessionID: input.sessionID
  });
  const completed = attempts.find((attempt) => cleanString(attempt.result_provider_turn_id) !== "");
  if (completed) return skipAttempt(db, input, {
    attempt: completed, outcome: "already_started", turnID: completed.result_provider_turn_id
  });
  const existing = attempts[0];
  if (state.observedTurnID !== "" && state.observedTurnID !== state.expectedTurnID) {
    return existing ? skipAttempt(db, input, {
      attempt: existing, outcome: "progress", turnID: state.observedTurnID
    }) : skipResult("progress", state.observedTurnID);
  }
  const held = attempts.find((attempt) =>
    attempt.status === "executing" && !hardTimeoutElapsed(attempt.hard_timeout_at));
  if (held) return skipResult("attempt_executing", "");
  return state.createWhenReady ? { attempt: createExecutingAttempt(db, input, state), skip: false } : null;
}

function createExecutingAttempt(
  db: RunnerDatabase,
  input: ResumeAttemptInput,
  state: PrepareState
): PiRecoveryAttempt {
  const timestamp = new Date().toISOString();
  return recordPiRecoveryAttempt(db, {
    action_type: input.action.action_type,
    before_snapshot_json: beforeSnapshot(input.payload),
    budget_window_started_at: timestamp,
    diagnosis_code: cleanString(input.payload.diagnosis_code) || "session_resume_followup",
    executing_started_at: timestamp,
    expected_provider_turn_id: state.expectedTurnID,
    hard_timeout_at: hardTimeoutAt(input.payload),
    id: `recovery-${input.action.id}`,
    idempotency_key: resumeAttemptKey(input, state.expectedTurnID),
    issue_id: input.issueID,
    project_id: input.action.project_id,
    provider_session_id: input.sessionID,
    provider_turn_id: state.observedTurnID || state.expectedTurnID,
    run_id: cleanString(input.payload.expected_run_id),
    session_id: `${input.providerID}:${input.sessionID}`,
    source_decision_id: cleanString(input.payload.decision_id) || input.action.id,
    status: "executing"
  });
}

function skipAttempt(
  db: RunnerDatabase,
  input: ResumeAttemptInput,
  skip: SkipInput
): ResumeAttemptPreparation {
  updatePiRecoveryAttemptStatus(db, skip.attempt.id, {
    progress_detected: skip.turnID === "" ? 0 : 1,
    progress_reasons_json: skip.turnID === "" ? [] : ["provider_turn_advanced"],
    result_provider_turn_id: skip.turnID,
    status: skip.turnID === "" ? "superseded" : "progress"
  });
  if (skip.turnID !== "") persistObservedTurn(db, input, skip.turnID);
  return skipResult(skip.outcome, skip.turnID);
}

function persistObservedTurn(db: RunnerDatabase, input: ResumeAttemptInput, turnID: string): void {
  updateIssueRuntime(db, input.issueID, {
    metadata: { supervisor_action_id: input.action.id, supervisor_recovery: true },
    provider: input.providerID,
    provider_session_id: input.sessionID,
    provider_turn_id: turnID
  });
  upsertAgentSession(db, {
    issue_id: input.issueID,
    project_id: input.action.project_id,
    provider: input.providerID,
    provider_session_id: input.sessionID,
    raw_ref: { provider_turn_id: turnID, supervisor_action_id: input.action.id },
    status: "running"
  });
}

async function observedProviderTurnID(
  db: RunnerDatabase,
  provider: ExecutorProvider,
  providerID: ExecutorProviderId,
  sessionID: string
): Promise<string> {
  const providerTurnID = await readProviderTurnID(provider, sessionID);
  if (providerTurnID !== "") return providerTurnID;
  return rawRefTurnID(getAgentSession(db, `${providerID}:${sessionID}`)?.raw_ref);
}

async function readProviderTurnID(provider: ExecutorProvider, sessionID: string): Promise<string> {
  if (!provider.readSession) return "";
  try {
    return turnIDFromSession(await provider.readSession(sessionID));
  } catch {
    return "";
  }
}

function turnIDFromSession(session: Record<string, unknown>): string {
  return cleanString(session.provider_turn_id) || cleanString(session.turn_id) ||
    cleanString(session.turnId) || lastTurnID(session.turns);
}

function lastTurnID(value: unknown): string {
  if (!Array.isArray(value)) return "";
  for (const turn of [...value].reverse()) {
    const id = cleanString(objectPayload(turn).id) || cleanString(objectPayload(turn).turn_id);
    if (id !== "") return id;
  }
  return "";
}

function hardTimeoutElapsed(value: string): boolean {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && Date.now() >= ms;
}

function hardTimeoutAt(payload: Record<string, unknown>): string {
  return cleanString(payload.hard_timeout_at) || new Date(Date.now() + HARD_TIMEOUT_MS).toISOString();
}

function resumeAttemptKey(input: ResumeAttemptInput, expectedTurnID: string): string {
  return [
    "resume",
    input.sessionID,
    expectedTurnID,
    cleanString(input.payload.decision_id) || input.action.id || cleanString(input.payload.diagnosis_code)
  ].join(":");
}

function beforeSnapshot(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    issue: { status: cleanString(payload.expected_issue_status), updated_at: cleanString(payload.expected_issue_updated_at) },
    run: { status: cleanString(payload.expected_run_status), updated_at: cleanString(payload.expected_run_ended_at) },
    session: { status: cleanString(payload.expected_session_status), updated_at: cleanString(payload.expected_session_updated_at) }
  };
}

function skipResult(outcome: string, turnID: string): ResumeAttemptPreparation {
  return { result: { outcome, provider_turn_id: turnID, skipped: true }, skip: true };
}

function requiredText(value: unknown, key: string): string {
  const text = cleanString(value);
  if (text === "") throw new Error(`${key} is required`);
  return text;
}

function rawRefTurnID(rawRef: string | undefined): string {
  if (!rawRef) return "";
  try { return cleanString((JSON.parse(rawRef) as Record<string, unknown>).provider_turn_id); } catch { return ""; }
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
