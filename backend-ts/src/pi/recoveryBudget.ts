import type { RunnerDatabase } from "../db/database.ts";
import {
  countPiRecoveryAttempts,
  latestPiRecoveryAttemptInWindow,
  type PiRecoveryAttemptStatus
} from "../db/repositories/pi/recoveryAttempts.ts";

export type PiRecoveryBudgetInput = {
  actionType: string;
  issueID: number;
  issueLimit?: number;
  now: Date;
  projectID: string;
  projectLimit?: number;
  sessionID?: string;
  sessionResumeLimit?: number;
};
export type PiRecoveryBudgetStatus =
  "allow" | "issue_budget_exhausted" | "session_resume_exhausted" | "project_budget_exhausted";
export type PiRecoveryBudgetDecision = {
  diagnosis_code: "recovery_budget_exhausted" | "session_recovery_exhausted" | "";
  issue_attempts_24h: number;
  issue_budget_remaining: number;
  issue_limit: number;
  issue_window_started_at: string;
  last_action_at: string;
  last_attempt_error?: string;
  last_action_type: string;
  last_attempt_id: string;
  last_attempt_status: string;
  project_attempts_1h: number;
  project_budget_remaining: number;
  project_budget_unlimited: boolean;
  project_defer_until: string;
  project_limit: number;
  project_window_started_at: string;
  recommended_action: "allow" | "budget_exhausted" | "defer_or_escalate";
  session_resume_attempts_24h: number;
  session_resume_budget_remaining: number;
  session_resume_limit: number;
  status: PiRecoveryBudgetStatus;
};

export type RecoveryHistoryBudgetInput = Record<string, unknown>;
export type RecoveryBudgetCandidate = {
  diagnosis_code: "recovery_budget_exhausted" | "session_recovery_exhausted";
  evidence_refs: ["recovery_budget"];
  exhausted: true;
  reason: string;
};

const BUDGET_STATUSES: PiRecoveryAttemptStatus[] = ["planned", "executing", "progress", "no_progress", "failed"];
const DEFAULT_ISSUE_LIMIT = 6;
const DEFAULT_SESSION_RESUME_LIMIT = 6;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

export function readPiRecoveryBudget(db: RunnerDatabase, input: PiRecoveryBudgetInput): PiRecoveryBudgetDecision {
  const limits = normalizedLimits(input);
  const issueSince = iso(input.now.getTime() - DAY_MS);
  const projectSince = iso(input.now.getTime() - HOUR_MS);
  const issueLastAttempt = latestPiRecoveryAttemptInWindow(db, {
    issueId: input.issueID,
    since: issueSince,
    statuses: BUDGET_STATUSES
  });
  const issueAttempts = countPiRecoveryAttempts(db, {
    issueId: input.issueID,
    since: issueSince,
    statuses: BUDGET_STATUSES
  });
  const sessionAttempts = sessionResumeAttempts(db, input, issueSince);
  const projectAttempts = countPiRecoveryAttempts(db, {
    projectId: input.projectID,
    since: projectSince,
    statuses: BUDGET_STATUSES
  });
  return decision(input, {
    issueAttempts,
    projectAttempts,
    projectSince,
    issueSince,
    issueLastAttempt,
    sessionAttempts,
    ...limits
  });
}

export function applyRecoveryBudgetToHistory(
  history: RecoveryHistoryBudgetInput,
  budget: PiRecoveryBudgetDecision
): RecoveryHistoryBudgetInput {
  return {
    ...history,
    attempts_24h: budget.issue_attempts_24h,
    budget_diagnosis_code: budget.diagnosis_code,
    budget_reason: budgetReason(budget),
    budget_remaining: budget.issue_budget_remaining,
    budget_status: budget.status,
    budget_window_started_at: budget.issue_window_started_at,
    last_action_at: budget.last_action_at,
    last_action_error: budget.last_attempt_error,
    last_action_status: budget.last_attempt_status,
    last_action_type: budget.last_action_type,
    last_recovery_attempt_id: budget.last_attempt_id,
    project_attempts_1h: budget.project_attempts_1h,
    project_budget_remaining: budget.project_budget_remaining,
    project_budget_unlimited: budget.project_budget_unlimited,
    project_defer_until: budget.project_defer_until,
    project_window_started_at: budget.project_window_started_at,
    session_resume_attempts_24h: budget.session_resume_attempts_24h,
    session_resume_budget_remaining: budget.session_resume_budget_remaining
  };
}

export function recoveryBudgetCandidate(history: RecoveryHistoryBudgetInput): RecoveryBudgetCandidate | null {
  const diagnosis = clean(history.budget_diagnosis_code);
  if (diagnosis !== "recovery_budget_exhausted" && diagnosis !== "session_recovery_exhausted") return null;
  return {
    diagnosis_code: diagnosis,
    evidence_refs: ["recovery_budget"],
    exhausted: true,
    reason: clean(history.budget_reason) || "automatic recovery budget exhausted"
  };
}

function decision(
  input: PiRecoveryBudgetInput,
  state: {
    issueAttempts: number; issueLastAttempt: ReturnType<typeof latestPiRecoveryAttemptInWindow>;
    issueLimit: number; issueSince: string;
    projectAttempts: number; projectLimit: number; projectSince: string;
    sessionAttempts: number; sessionLimit: number;
  }
): PiRecoveryBudgetDecision {
  const base = baseDecision(state);
  if (isSessionResume(input.actionType) && state.sessionAttempts >= state.sessionLimit) {
    return exhausted(base, "session_resume_exhausted", "session_recovery_exhausted", "budget_exhausted");
  }
  if (state.issueAttempts >= state.issueLimit) {
    return exhausted(base, "issue_budget_exhausted", "recovery_budget_exhausted", "budget_exhausted");
  }
  return base;
}

function baseDecision(state: {
  issueAttempts: number; issueLastAttempt: ReturnType<typeof latestPiRecoveryAttemptInWindow>;
  issueLimit: number; issueSince: string;
  projectAttempts: number; projectLimit: number; projectSince: string;
  sessionAttempts: number; sessionLimit: number;
}): PiRecoveryBudgetDecision {
  return withLastAttempt({
    diagnosis_code: "",
    issue_attempts_24h: state.issueAttempts,
    issue_budget_remaining: remaining(state.issueLimit, state.issueAttempts),
    issue_limit: state.issueLimit,
    issue_window_started_at: state.issueSince,
    last_action_at: "",
    last_attempt_error: "",
    last_action_type: "",
    last_attempt_id: "",
    last_attempt_status: "",
    project_attempts_1h: state.projectAttempts,
    project_budget_remaining: 0,
    project_budget_unlimited: true,
    project_defer_until: "",
    project_limit: state.projectLimit,
    project_window_started_at: state.projectSince,
    recommended_action: "allow",
    session_resume_attempts_24h: state.sessionAttempts,
    session_resume_budget_remaining: remaining(state.sessionLimit, state.sessionAttempts),
    session_resume_limit: state.sessionLimit,
    status: "allow"
  }, state.issueLastAttempt);
}

function exhausted(
  base: PiRecoveryBudgetDecision,
  status: PiRecoveryBudgetStatus,
  diagnosis: PiRecoveryBudgetDecision["diagnosis_code"],
  action: PiRecoveryBudgetDecision["recommended_action"]
): PiRecoveryBudgetDecision {
  return { ...base, diagnosis_code: diagnosis, recommended_action: action, status };
}

function withLastAttempt(
  base: PiRecoveryBudgetDecision,
  attempt: ReturnType<typeof latestPiRecoveryAttemptInWindow>
): PiRecoveryBudgetDecision {
  return {
    ...base,
    last_action_at: attempt?.created_at ?? "",
    last_attempt_error: attempt?.error ?? "",
    last_action_type: attempt?.action_type ?? "",
    last_attempt_id: attempt?.id ?? "",
    last_attempt_status: attempt?.status ?? ""
  };
}

function sessionResumeAttempts(db: RunnerDatabase, input: PiRecoveryBudgetInput, since: string): number {
  const sessionID = clean(input.sessionID);
  if (sessionID === "") return 0;
  return countPiRecoveryAttempts(db, {
    actionType: "session.resume_followup",
    sessionId: sessionID,
    since,
    statuses: BUDGET_STATUSES
  });
}

function normalizedLimits(input: PiRecoveryBudgetInput): {
  issueLimit: number; projectLimit: number; sessionLimit: number;
} {
  return {
    issueLimit: positiveInt(input.issueLimit, DEFAULT_ISSUE_LIMIT),
    projectLimit: 0,
    sessionLimit: positiveInt(input.sessionResumeLimit, DEFAULT_SESSION_RESUME_LIMIT)
  };
}

function budgetReason(budget: PiRecoveryBudgetDecision): string {
  if (budget.status === "allow") return "";
  if (budget.status === "session_resume_exhausted") return "session resume budget exhausted";
  return "issue automatic recovery budget exhausted";
}

function isSessionResume(actionType: string): boolean {
  return clean(actionType) === "session.resume_followup";
}

function remaining(limit: number, count: number): number {
  return Math.max(0, limit - count);
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function iso(value: number): string {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z");
}
