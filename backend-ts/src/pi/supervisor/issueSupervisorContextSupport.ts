import { type AgentSession } from "../../db/repositories/agentSessions.ts";
import type { IssueEvent } from "../../db/repositories/issueEvents.ts";
import type { IssueRun } from "../../db/repositories/issues.ts";
import { type IssueSupervisorEvent, type readProjectPiPolicy } from "../../db/repositories/pi.ts";
import { parseIssueEventProviderError, type ProviderErrorSignal } from "./providerErrorParser.ts";
import type { PiSupervisorDiagnosisCode } from "./issueSupervisorRecovery.ts";
import { recoveryBudgetCandidate } from "./recoveryBudget.ts";
import { providerOutageCandidate } from "./providerOutageDiagnosis.ts";
import { cleanString } from "../../util/values.ts";
import { stoppedSession, staleSession, activeStatus, providerErrorCandidate, blocksStoppedRecovery, isRecoveryAction, consecutiveNoProgress, outcome, latestTimestamp, runState, supervisorSessionStatus } from "./issueSupervisorContextProjection.ts";
import { parsePayload, jsonArray, ageSeconds } from "./issueSupervisorContextValues.ts";

export type RecentSupervisorEvent = {
  at: string;
  id: number;
  markers: string[];
  summary: string;
  type: string;
};

export type SupervisorCandidate = {
  diagnosis_code: PiSupervisorDiagnosisCode;
  evidence_refs: string[];
  exhausted?: boolean;
  reason: string;
  source_event_type?: string;
  wait_until?: string;
};

export type CandidateInput = {
  activityUpdatedAt?: string;
  events: IssueEvent[];
  history: Record<string, unknown>;
  issueStatus: string;
  retryAfterAt?: string;
  legacyInvalidFallbackDiagnosis?: PiSupervisorDiagnosisCode;
  latestRun: IssueRun | null;
  now: Date;
  policy?: { supervisor_cooldown_seconds?: number };
  projectDeferredCount?: number;
  providerError: ProviderErrorSignal | null;
  session: AgentSession | null;
  staleAfterSeconds?: number;
};

export type PolicyContextInput = {
  history: Record<string, unknown>;
  policy: ReturnType<typeof readProjectPiPolicy>;
};

export type SessionContextInput = {
  activityUpdatedAt?: string;
  latestRun: IssueRun | null;
  now: Date;
  session: AgentSession | null;
  staleAfterSeconds: number;
};

export const DEFAULT_STALE_SECONDS = 15 * 60;

export const RECOVERY_ACTIONS = new Set([
  "session.resume_followup",
  "session.steer",
  "issue.retry",
  "issue.retry_after",
  "issue.state_repair"
]);

export function candidates(input: CandidateInput): SupervisorCandidate[] {
  const out: SupervisorCandidate[] = [];
  const { providerError, session, history, latestRun, now } = input;
  // 已结束的运行交给验收；普通等待不能被预算或旧错误再次抢占。
  if (input.issueStatus === "in_progress" && latestRun?.ended_at) return out;
  if (Date.parse(input.retryAfterAt ?? "") > now.getTime()) return out;
  const runOpen = latestRun?.status === "in_progress" && latestRun.ended_at === "";
  const stopped = stoppedSession(session);
  const stale = staleSession(session, input.activityUpdatedAt, now, input.staleAfterSeconds ?? DEFAULT_STALE_SECONDS);
  const freshActiveRun = runOpen && session !== null && activeStatus(session.status) && !stopped && !stale;
  const budgetCandidate = recoveryBudgetCandidate(history);
  if (budgetCandidate && !freshActiveRun) {
    out.push(budgetCandidate);
    return out;
  }
  if (!freshActiveRun && (Number(history.consecutive_no_progress) >= 2 || Number(history.budget_remaining) <= 0)) {
    out.push({
      diagnosis_code: "session_recovery_exhausted",
      evidence_refs: ["recovery_history"],
      exhausted: true,
      reason: "recovery budget exhausted without meaningful progress"
    });
    return out;
  }
  const outageCandidate = providerOutageCandidate(input);
  if (outageCandidate) return [outageCandidate];
  const diagnosis = providerError?.diagnosis_code;
  const failedAttempt = input.issueStatus === "failed" && latestRun?.ended_at !== "";
  if (failedAttempt && providerError?.diagnosis_code) {
    out.push(providerErrorCandidate(input, providerError, providerError.diagnosis_code));
    return out;
  }
  if (failedAttempt && input.legacyInvalidFallbackDiagnosis) {
    out.push({
      diagnosis_code: input.legacyInvalidFallbackDiagnosis,
      evidence_refs: ["issue", "supervisor_decision_failed"],
      reason: "legacy invalid Supervisor fallback closed the Issue; re-evaluate it under the current autonomous recovery policy"
    });
    return out;
  }
  if (failedAttempt) {
    out.push({
      diagnosis_code: "requires_human_decision",
      evidence_refs: ["issue", "latest_run"],
      reason: "executor attempt ended in a deterministic failure without an explicit transient provider diagnosis"
    });
    return out;
  }
  if (diagnosis) {
    out.push(providerErrorCandidate(input, providerError, diagnosis));
    return out;
  }
  if (runOpen && stopped && !blocksStoppedRecovery(providerError)) {
    out.push({ diagnosis_code: "session_no_recent_progress", evidence_refs: ["session"], reason: "session is idle while issue run remains open" });
  }
  if (runOpen && !diagnosis && !stopped && stale) {
    out.push({ diagnosis_code: "session_no_recent_progress", evidence_refs: ["session"], reason: "session has no recent updates" });
  }
  return out;
}

export function latestProviderError(events: IssueEvent[], now: Date): ProviderErrorSignal | null {
  for (const event of [...events].reverse()) {
    if (event.type === "issue.supervisor_resume_followup" || event.type === "issue.provider_session_reconciled.v1") return null;
    // 调度器的等待决定不是 Provider 错误，不能自行制造 rate_limit。
    if (event.type === "issue.retry_after_scheduled") continue;
    const payload = parsePayload(event.payload);
    const signal = adjustRetryWindow(
      parseIssueEventProviderError(payload, { now: eventDate(event, now) }),
      now,
      eventDate(event, now)
    );
    if (signal.category !== "unknown") return signal;
  }
  return null;
}

export function adjustRetryWindow(signal: ProviderErrorSignal, now: Date, observedAt: Date): ProviderErrorSignal {
  const retryAfterAt = cleanString(signal.retry_after_at);
  const observed = signal.observed_at || observedAt.toISOString();
  if (signal.category !== "rate_limit" || retryAfterAt === "") return { ...signal, observed_at: observed };
  return {
    ...signal,
    diagnosis_code: retryDiagnosis(retryAfterAt, now),
    observed_at: observed,
    retry_after_seconds: secondsUntil(retryAfterAt, now)
  };
}

export function retryDiagnosis(retryAfterAt: string, now: Date): ProviderErrorSignal["diagnosis_code"] {
  return Date.parse(retryAfterAt) > now.getTime() ? "provider_retry_after_waiting" : "provider_retry_after_ready";
}

export function secondsUntil(value: string, now: Date): number {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.max(0, Math.ceil((ms - now.getTime()) / 1_000)) : 0;
}

export function eventDate(event: IssueEvent, fallback: Date): Date {
  const ms = Date.parse(event.created_at);
  return Number.isFinite(ms) ? new Date(ms) : fallback;
}

export function recoveryHistory(
  events: IssueSupervisorEvent[],
  maxRecoveries: number,
  now: Date
): Record<string, unknown> {
  const since = now.getTime() - 24 * 60 * 60 * 1_000;
  const actions24h = events.filter((event) => isRecoveryAction(event) && Date.parse(event.created_at) >= since);
  const resultEvents = events.filter((event) => event.event_type === "result");
  const lastResult = resultEvents.at(-1);
  const attempts = actions24h.length;
  return {
    attempts_24h: attempts,
    budget_remaining: Math.max(0, maxRecoveries - attempts),
    consecutive_no_progress: consecutiveNoProgress(resultEvents),
    last_action_at: events.filter(isRecoveryAction).at(-1)?.created_at ?? "",
    last_outcome: outcome(lastResult) || "unknown"
  };
}

export function policyContext(input: PolicyContextInput): Record<string, unknown> {
  const { policy, history } = input;
  return {
    allowed_actions: jsonArray(policy.allowed_supervisor_actions_json),
    budget_remaining: history.budget_remaining,
    cooldown_seconds: policy.supervisor_cooldown_seconds,
    mode: "autonomous",
    project_budget_unlimited: true,
    rate_limit_wait_policy: policy.supervisor_rate_limit_wait_policy
  };
}

export function sessionContext(input: SessionContextInput): Record<string, unknown> {
  const { session, latestRun, now, staleAfterSeconds } = input;
  const freshestAt = latestTimestamp(session?.updated_at, input.activityUpdatedAt);
  const staleGap = freshestAt ? ageSeconds(freshestAt, now) : 0;
  return {
    activity_updated_at: input.activityUpdatedAt ?? "",
    provider: latestRun?.provider ?? session?.provider ?? "",
    provider_session_id: latestRun?.provider_session_id || session?.provider_session_id || "",
    provider_turn_id: latestRun?.provider_turn_id ?? "",
    raw_status: session?.status ?? "",
    run_state: runState(latestRun),
    status: supervisorSessionStatus({ session, run: latestRun, staleGap, staleAfterSeconds }),
    stale_gap_seconds: staleGap,
    updated_at: session?.updated_at ?? ""
  };
}

export { workspaceSnapshot, summarizeIssueEvent, resolveSession, issueContext, projectContext, runContext } from "./issueSupervisorContextProjection.ts";
