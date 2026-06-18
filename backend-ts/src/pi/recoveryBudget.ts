import type { RunnerDatabase } from "../db/database.ts";
import {
  countPiRecoveryAttempts,
  firstPiRecoveryAttemptCreatedAt,
  type PiRecoveryAttemptStatus
} from "../db/repositories/pi/recoveryAttempts.ts";

export type PiRecoveryBudgetInput = {
  actionType: string;
  issueID: number;
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
  project_attempts_1h: number;
  project_budget_remaining: number;
  project_defer_until: string;
  project_limit: number;
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
const DEFAULT_ISSUE_LIMIT = 3;
const DEFAULT_PROJECT_LIMIT = 10;
const DEFAULT_SESSION_RESUME_LIMIT = 2;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

export function readPiRecoveryBudget(db: RunnerDatabase, input: PiRecoveryBudgetInput): PiRecoveryBudgetDecision {
  const limits = normalizedLimits(input);
  const issueSince = iso(input.now.getTime() - DAY_MS);
  const projectSince = iso(input.now.getTime() - HOUR_MS);
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
    projectDeferUntil: deferUntil(db, input, limits, projectAttempts, projectSince),
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
    project_attempts_1h: budget.project_attempts_1h,
    project_budget_remaining: budget.project_budget_remaining,
    project_defer_until: budget.project_defer_until,
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
    issueAttempts: number; issueLimit: number; projectAttempts: number; projectDeferUntil: string;
    projectLimit: number; sessionAttempts: number; sessionLimit: number;
  }
): PiRecoveryBudgetDecision {
  const base = baseDecision(state);
  if (state.issueAttempts >= state.issueLimit) {
    return exhausted(base, "issue_budget_exhausted", "recovery_budget_exhausted", "budget_exhausted");
  }
  if (isSessionResume(input.actionType) && state.sessionAttempts >= state.sessionLimit) {
    return exhausted(base, "session_resume_exhausted", "session_recovery_exhausted", "budget_exhausted");
  }
  if (state.projectAttempts >= state.projectLimit) {
    return { ...base, recommended_action: "defer_or_escalate", status: "project_budget_exhausted" };
  }
  return base;
}

function baseDecision(state: {
  issueAttempts: number; issueLimit: number; projectAttempts: number; projectDeferUntil: string;
  projectLimit: number; sessionAttempts: number; sessionLimit: number;
}): PiRecoveryBudgetDecision {
  return {
    diagnosis_code: "",
    issue_attempts_24h: state.issueAttempts,
    issue_budget_remaining: remaining(state.issueLimit, state.issueAttempts),
    issue_limit: state.issueLimit,
    project_attempts_1h: state.projectAttempts,
    project_budget_remaining: remaining(state.projectLimit, state.projectAttempts),
    project_defer_until: state.projectDeferUntil,
    project_limit: state.projectLimit,
    recommended_action: "allow",
    session_resume_attempts_24h: state.sessionAttempts,
    session_resume_budget_remaining: remaining(state.sessionLimit, state.sessionAttempts),
    session_resume_limit: state.sessionLimit,
    status: "allow"
  };
}

function exhausted(
  base: PiRecoveryBudgetDecision,
  status: PiRecoveryBudgetStatus,
  diagnosis: PiRecoveryBudgetDecision["diagnosis_code"],
  action: PiRecoveryBudgetDecision["recommended_action"]
): PiRecoveryBudgetDecision {
  return { ...base, diagnosis_code: diagnosis, recommended_action: action, status };
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

function projectDeferUntil(db: RunnerDatabase, input: PiRecoveryBudgetInput, since: string): string {
  const first = firstPiRecoveryAttemptCreatedAt(db, {
    projectId: input.projectID,
    since,
    statuses: BUDGET_STATUSES
  });
  const time = Date.parse(first);
  return Number.isFinite(time) ? iso(time + HOUR_MS) : "";
}

function normalizedLimits(input: PiRecoveryBudgetInput): {
  issueLimit: number; projectLimit: number; sessionLimit: number;
} {
  return {
    issueLimit: DEFAULT_ISSUE_LIMIT,
    projectLimit: positiveInt(input.projectLimit, DEFAULT_PROJECT_LIMIT),
    sessionLimit: positiveInt(input.sessionResumeLimit, DEFAULT_SESSION_RESUME_LIMIT)
  };
}

function deferUntil(
  db: RunnerDatabase,
  input: PiRecoveryBudgetInput,
  limits: ReturnType<typeof normalizedLimits>,
  projectAttempts: number,
  since: string
): string {
  return projectAttempts >= limits.projectLimit ? projectDeferUntil(db, input, since) : "";
}

function budgetReason(budget: PiRecoveryBudgetDecision): string {
  if (budget.status === "allow") return "";
  if (budget.status === "project_budget_exhausted") return "project automatic recovery budget exhausted";
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
