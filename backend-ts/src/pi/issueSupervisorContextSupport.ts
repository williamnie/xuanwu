import { getAgentSession, type AgentSession } from "../db/repositories/agentSessions.ts";
import type { IssueEvent } from "../db/repositories/issueEvents.ts";
import type { Issue, IssueRun } from "../db/repositories/issues.ts";
import { type IssueSupervisorEvent, type readProjectPiPolicy } from "../db/repositories/pi.ts";
import type { Project } from "../db/repositories/projects.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { redactAuditJsonText, redactAuditText } from "../db/repositories/pi/auditRedaction.ts";
import { parseIssueEventProviderError, type ProviderErrorSignal } from "./providerErrorParser.ts";
import type { PiSupervisorDiagnosisCode } from "./issueSupervisorRecovery.ts";

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
  wait_until?: string;
};

type CandidateInput = {
  history: Record<string, unknown>;
  now: Date;
  providerError: ProviderErrorSignal | null;
  session: AgentSession | null;
};

type PolicyContextInput = {
  history: Record<string, unknown>;
  now: Date;
  policy: ReturnType<typeof readProjectPiPolicy>;
  projectEvents: IssueSupervisorEvent[];
};

type SessionContextInput = {
  latestRun: IssueRun | null;
  now: Date;
  session: AgentSession | null;
  staleAfterSeconds: number;
};

const DEFAULT_STALE_SECONDS = 6 * 60 * 60;
const RECOVERY_ACTIONS = new Set(["session.resume_followup", "session.steer", "issue.retry"]);

export function candidates(input: CandidateInput): SupervisorCandidate[] {
  const out: SupervisorCandidate[] = [];
  const { providerError, session, history, now } = input;
  if (Number(history.consecutive_no_progress) >= 2 || Number(history.budget_remaining) <= 0) {
    out.push({
      diagnosis_code: "session_recovery_exhausted",
      evidence_refs: ["recovery_history"],
      exhausted: true,
      reason: "recovery budget exhausted without meaningful progress"
    });
    return out;
  }
  const diagnosis = providerError?.diagnosis_code;
  if (diagnosis) out.push(providerErrorCandidate(providerError, diagnosis));
  if (!diagnosis && staleSession(session, now)) {
    out.push({ diagnosis_code: "session_no_recent_progress", evidence_refs: ["session"], reason: "session has no recent updates" });
  }
  return out;
}

export function latestProviderError(events: IssueEvent[], now: Date): ProviderErrorSignal | null {
  for (const event of [...events].reverse()) {
    const signal = parseIssueEventProviderError(parsePayload(event.payload), { now });
    if (signal.category !== "unknown") return signal;
  }
  return null;
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
  const { policy, history, projectEvents, now } = input;
  const projectAttempts = projectEvents.filter((event) =>
    isRecoveryAction(event) && Date.parse(event.created_at) >= now.getTime() - 60 * 60 * 1_000
  ).length;
  return {
    allowed_actions: jsonArray(policy.allowed_supervisor_actions_json),
    budget_remaining: history.budget_remaining,
    cooldown_seconds: policy.supervisor_cooldown_seconds,
    mode: policy.supervisor_mode,
    project_budget_remaining: Math.max(0, policy.supervisor_max_recoveries_per_project_per_hour - projectAttempts),
    rate_limit_wait_policy: policy.supervisor_rate_limit_wait_policy
  };
}

export function sessionContext(input: SessionContextInput): Record<string, unknown> {
  const { session, latestRun, now, staleAfterSeconds } = input;
  const staleGap = session ? ageSeconds(session.updated_at, now) : 0;
  return {
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

export function workspaceSnapshot(cwd: string, events: RecentSupervisorEvent[]): Record<string, unknown> {
  const gitStatus = gitStatusSummary(cwd);
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
  providerError: ProviderErrorSignal,
  diagnosis: PiSupervisorDiagnosisCode
): SupervisorCandidate {
  return {
    diagnosis_code: diagnosis,
    evidence_refs: ["provider_error"],
    reason: providerError.raw_summary,
    ...(providerError.retry_after_at ? { wait_until: providerError.retry_after_at } : {})
  };
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
  if (staleGap >= staleAfterSeconds && run?.ended_at === "") return "disconnected";
  return activeStatus(session.status) ? "active" : "unknown";
}

function staleSession(session: AgentSession | null, now: Date): boolean {
  return session ? ageSeconds(session.updated_at, now) >= DEFAULT_STALE_SECONDS : false;
}

function activeStatus(value: string): boolean {
  return ["running", "inprogress", "started", "active"].includes(value.trim().toLowerCase());
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
