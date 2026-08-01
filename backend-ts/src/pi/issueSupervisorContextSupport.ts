import { getAgentSession, type AgentSession } from "../db/repositories/agentSessions.ts";
import type { IssueEvent } from "../db/repositories/issueEvents.ts";
import type { Issue, IssueRun } from "../db/repositories/issues.ts";
import { type IssueSupervisorEvent, type readProjectPiPolicy } from "../db/repositories/pi.ts";
import type { Project } from "../db/repositories/projects.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { redactAuditJsonText, redactAuditText } from "../db/repositories/pi/auditRedaction.ts";
import { parseIssueEventProviderError, type ProviderErrorSignal } from "./providerErrorParser.ts";
import type { PiSupervisorDiagnosisCode } from "./issueSupervisorRecovery.ts";
import { recoveryBudgetCandidate } from "./recoveryBudget.ts";
import { providerOutageCandidate } from "./providerOutageDiagnosis.ts";

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

type CandidateInput = {
  activityUpdatedAt?: string;
  events: IssueEvent[];
  history: Record<string, unknown>;
  issueStatus: string;
  legacyInvalidFallbackDiagnosis?: PiSupervisorDiagnosisCode;
  latestRun: IssueRun | null;
  now: Date;
  policy?: { supervisor_cooldown_seconds?: number };
  projectDeferredCount?: number;
  providerError: ProviderErrorSignal | null;
  session: AgentSession | null;
  staleAfterSeconds?: number;
};

type PolicyContextInput = {
  history: Record<string, unknown>;
  policy: ReturnType<typeof readProjectPiPolicy>;
};

type SessionContextInput = {
  activityUpdatedAt?: string;
  latestRun: IssueRun | null;
  now: Date;
  session: AgentSession | null;
  staleAfterSeconds: number;
};

const DEFAULT_STALE_SECONDS = 15 * 60;
const RECOVERY_ACTIONS = new Set([
  "session.resume_followup",
  "session.steer",
  "issue.retry",
  "issue.retry_after",
  "issue.state_repair"
]);

export function candidates(input: CandidateInput): SupervisorCandidate[] {
  const out: SupervisorCandidate[] = [];
  const { providerError, session, history, latestRun, now } = input;
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
    const payload = parsePayload(event.payload);
    const signal = adjustRetryWindow(
      parseIssueEventProviderError(payload, { now: eventDate(event, now) }),
      now,
      eventDate(event, now)
    );
    if (signal.category !== "unknown") return signal;
    const scheduled = retryAfterScheduledSignal(event, payload, now);
    if (scheduled) return scheduled;
  }
  return null;
}

function retryAfterScheduledSignal(event: IssueEvent, payload: unknown, now: Date): ProviderErrorSignal | null {
  if (event.type !== "issue.retry_after_scheduled") return null;
  const record = objectValue(payload);
  const retryAfterAt = clean(record.retry_after_at);
  if (retryAfterAt === "" || !Number.isFinite(Date.parse(retryAfterAt))) return null;
  return {
    category: "rate_limit",
    diagnosis_code: retryDiagnosis(retryAfterAt, now),
    observed_at: event.created_at,
    raw_summary: truncate(redactAuditText(clean(record.reason) || "issue retry-after scheduled")),
    retry_after_at: retryAfterAt,
    retry_after_seconds: secondsUntil(retryAfterAt, now),
    source_event_type: event.type
  };
}

function adjustRetryWindow(signal: ProviderErrorSignal, now: Date, observedAt: Date): ProviderErrorSignal {
  const retryAfterAt = clean(signal.retry_after_at);
  const observed = signal.observed_at || observedAt.toISOString();
  if (signal.category !== "rate_limit" || retryAfterAt === "") return { ...signal, observed_at: observed };
  return {
    ...signal,
    diagnosis_code: retryDiagnosis(retryAfterAt, now),
    observed_at: observed,
    retry_after_seconds: secondsUntil(retryAfterAt, now)
  };
}

function retryDiagnosis(retryAfterAt: string, now: Date): ProviderErrorSignal["diagnosis_code"] {
  return Date.parse(retryAfterAt) > now.getTime() ? "provider_retry_after_waiting" : "provider_retry_after_ready";
}

function secondsUntil(value: string, now: Date): number {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.max(0, Math.ceil((ms - now.getTime()) / 1_000)) : 0;
}

function eventDate(event: IssueEvent, fallback: Date): Date {
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

export function workspaceSnapshot(
  cwd: string,
  events: RecentSupervisorEvent[],
  includeGit = true
): Record<string, unknown> {
  const gitStatus = includeGit ? gitStatusSummary(cwd) : { hash: "", summary: "omitted_for_scheduler_scan" };
  return {
    git_diff_hash: gitStatus.hash,
    git_status_summary: gitStatus.summary,
    last_agent_message: lastSummary(events, "agent_message"),
    last_commands: events.filter((event) => event.markers.includes("tool_command")).slice(-5).map((event) => event.summary),
    progress_markers: [...new Set(events.flatMap((event) => event.markers))]
  };
}

export function summarizeIssueEvent(event: IssueEvent): RecentSupervisorEvent {
  const payload = parsePayload(event.payload);
  const text = eventSummary(payload);
  return { at: event.created_at, id: event.id, markers: eventMarkers(event.type, payload, text), summary: text, type: event.type };
}

export function resolveSession(db: RunnerDatabase, issue: Issue, latestRun: IssueRun | null): AgentSession | null {
  const provider = latestRun?.provider || "codex";
  const sessionID = latestRun?.provider_session_id || issue.codex_thread_id;
  return sessionID ? getAgentSession(db, `${provider}:${sessionID}`) : null;
}

export function issueContext(issue: Issue): Record<string, unknown> {
  return {
    attempt_count: issue.attempt_count,
    id: issue.id,
    status: issue.status,
    title: redactAuditText(issue.title),
    updated_at: issue.updated_at
  };
}

export function projectContext(project: Project): Record<string, unknown> {
  return { auto_run: project.auto_run === 1, cwd: redactAuditText(project.cwd), id: project.id, provider: project.provider };
}

export function runContext(run: IssueRun): Record<string, unknown> {
  return {
    ended_at: run.ended_at,
    id: run.id,
    provider: run.provider,
    provider_session_id: run.provider_session_id,
    provider_turn_id: run.provider_turn_id,
    started_at: run.started_at,
    status: run.status
  };
}

function providerErrorCandidate(
  input: CandidateInput,
  providerError: ProviderErrorSignal,
  diagnosis: PiSupervisorDiagnosisCode
): SupervisorCandidate {
  const waitUntil = providerError.retry_after_at || cooldownWaitUntil(input, diagnosis);
  return {
    diagnosis_code: diagnosis,
    evidence_refs: ["provider_error"],
    reason: providerError.raw_summary,
    ...(providerError.source_event_type ? { source_event_type: providerError.source_event_type } : {}),
    ...(waitUntil ? { wait_until: waitUntil } : {})
  };
}

function cooldownWaitUntil(input: CandidateInput, diagnosis: PiSupervisorDiagnosisCode): string {
  if (diagnosis !== "provider_rate_limited") return "";
  const seconds = input.policy?.supervisor_cooldown_seconds ?? 0;
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  return iso((timeMs(input.providerError?.observed_at) ?? input.now.getTime()) + seconds * 1_000);
}

function eventMarkers(type: string, payload: unknown, text: string): string[] {
  const record = objectValue(payload);
  const markers: string[] = [];
  if (clean(record.command) !== "") markers.push("tool_command");
  if (clean(record.type) === "text" && clean(record.text) !== "") markers.push("agent_message");
  if (/test|vitest|verification/i.test(text)) markers.push("verification");
  if (/\bgit\s+commit\b|\bcommitted\b/i.test(text)) markers.push("commit");
  if (/codex-issue-runner\s+issue\s+update|issue update --id/i.test(text)) markers.push("issue_update");
  if (type === "issue.status_changed") markers.push("issue_status_update");
  return markers;
}

function eventSummary(payload: unknown): string {
  const record = objectValue(payload);
  const value = clean(record.text || record.error || record.command || record.raw_payload || payload);
  return truncate(redactAuditText(value || redactAuditJsonText(JSON.stringify(payload ?? {}))));
}

function runState(run: IssueRun | null): string {
  if (!run) return "unknown";
  return run.ended_at === "" ? "open" : "ended";
}

function supervisorSessionStatus(input: {
  run: IssueRun | null;
  session: AgentSession | null;
  staleAfterSeconds: number;
  staleGap: number;
}): string {
  const { session, run, staleGap, staleAfterSeconds } = input;
  if (!session && !run) return "unknown";
  if (run?.ended_at) return "ended";
  if (!session) return run?.ended_at === "" ? "unknown" : "ended";
  if (stoppedSession(session) && run?.ended_at === "") return normalizedStoppedStatus(session.status);
  if (staleGap >= staleAfterSeconds && run?.ended_at === "") return "disconnected";
  return activeStatus(session.status) ? "active" : "unknown";
}

function staleSession(
  session: AgentSession | null,
  activityUpdatedAt: string | undefined,
  now: Date,
  staleAfterSeconds: number
): boolean {
  if (!session) return false;
  return stoppedSession(session) || ageSeconds(latestTimestamp(session.updated_at, activityUpdatedAt), now) >= staleAfterSeconds;
}

function latestTimestamp(...values: Array<string | undefined>): string {
  return values.reduce<string>((latest, value) => {
    const candidate = Date.parse(value ?? "");
    return Number.isFinite(candidate) && candidate > Date.parse(latest || "1970-01-01T00:00:00Z")
      ? value ?? latest
      : latest;
  }, "");
}

function activeStatus(value: string): boolean {
  return ["running", "inprogress", "started", "active"].includes(value.trim().toLowerCase());
}

function stoppedSession(session: AgentSession | null): boolean {
  return session ? stoppedStatus(session.status) : false;
}

function blocksStoppedRecovery(providerError: ProviderErrorSignal | null): boolean {
  return ["auth", "permission", "quota"].includes(clean(providerError?.category));
}

function stoppedStatus(value: string): boolean {
  return ["idle", "stopped", "completed", "done", "failed", "error"].includes(value.trim().toLowerCase());
}

function normalizedStoppedStatus(value: string): string {
  const status = value.trim().toLowerCase();
  if (status === "completed" || status === "done") return "idle";
  if (status === "failed" || status === "error") return "failed";
  return status || "idle";
}

function consecutiveNoProgress(events: IssueSupervisorEvent[]): number {
  let count = 0;
  for (const event of [...events].reverse()) {
    if (outcome(event) !== "no_progress") break;
    count += 1;
  }
  return count;
}

function outcome(event: IssueSupervisorEvent | undefined): string {
  return clean(objectValue(parsePayload(event?.payload_json ?? "{}")).outcome);
}

function isRecoveryAction(event: IssueSupervisorEvent): boolean {
  return event.event_type === "action" && RECOVERY_ACTIONS.has(event.action_type);
}

function gitStatusSummary(cwd: string): { hash: string; summary: string } {
  try {
    const proc = Bun.spawnSync(["git", "-C", cwd, "status", "--short"], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) return { hash: "", summary: "unknown" };
    const text = new TextDecoder().decode(proc.stdout).trim();
    return { hash: hashText(text), summary: text === "" ? "clean" : `${text.split("\n").length} changed paths` };
  } catch {
    return { hash: "", summary: "unknown" };
  }
}

function parsePayload(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function jsonArray(value: string): string[] {
  const parsed = parsePayload(value);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function lastSummary(events: RecentSupervisorEvent[], marker: string): string {
  return events.filter((event) => event.markers.includes(marker)).at(-1)?.summary ?? "";
}

function ageSeconds(value: string, now: Date): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, Math.round((now.getTime() - timestamp) / 1_000)) : 0;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function truncate(value: string): string {
  return value.length <= 260 ? value : `${value.slice(0, 259)}…`;
}

function hashText(value: string): string {
  let hash = 0;
  for (const char of value) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return value === "" ? "" : String(hash >>> 0);
}

function timeMs(value: string | undefined): number | undefined {
  const ms = Date.parse(clean(value));
  return Number.isFinite(ms) ? ms : undefined;
}

function iso(value: number): string {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z");
}
