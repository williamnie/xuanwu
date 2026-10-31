import { getAgentSession, type AgentSession } from "../../db/repositories/agentSessions.ts";
import type { IssueEvent } from "../../db/repositories/issueEvents.ts";
import type { Issue, IssueRun } from "../../db/repositories/issues.ts";
import { type IssueSupervisorEvent } from "../../db/repositories/pi.ts";
import type { Project } from "../../db/repositories/projects.ts";
import type { RunnerDatabase } from "../../db/database.ts";
import { redactAuditJsonText, redactAuditText } from "../../db/repositories/pi/auditRedaction.ts";
import { type ProviderErrorSignal } from "./providerErrorParser.ts";
import type { PiSupervisorDiagnosisCode } from "./issueSupervisorRecovery.ts";
import { cleanString, objectValue } from "../../util/values.ts";
import { type RecentSupervisorEvent, CandidateInput, type SupervisorCandidate, RECOVERY_ACTIONS } from "./issueSupervisorContextSupport.ts";
import { gitStatusSummary, lastSummary, parsePayload, iso, timeMs, truncate, ageSeconds } from "./issueSupervisorContextValues.ts";

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

export function providerErrorCandidate(
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

export function cooldownWaitUntil(input: CandidateInput, diagnosis: PiSupervisorDiagnosisCode): string {
  if (diagnosis !== "provider_rate_limited") return "";
  const seconds = input.policy?.supervisor_cooldown_seconds ?? 0;
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  return iso((timeMs(input.providerError?.observed_at) ?? input.now.getTime()) + seconds * 1_000);
}

export function eventMarkers(type: string, payload: unknown, text: string): string[] {
  const record = objectValue(payload);
  const markers: string[] = [];
  if (cleanString(record.command) !== "") markers.push("tool_command");
  if (cleanString(record.type) === "text" && cleanString(record.text) !== "") markers.push("agent_message");
  if (/test|vitest|verification/i.test(text)) markers.push("verification");
  if (/\bgit\s+commit\b|\bcommitted\b/i.test(text)) markers.push("commit");
  if (/xuanwu\s+issue\s+update|issue update --id/i.test(text)) markers.push("issue_update");
  if (type === "issue.status_changed") markers.push("issue_status_update");
  return markers;
}

export function eventSummary(payload: unknown): string {
  const record = objectValue(payload);
  const value = cleanString(record.text || record.error || record.command || record.raw_payload || payload);
  return truncate(redactAuditText(value || redactAuditJsonText(JSON.stringify(payload ?? {}))));
}

export function runState(run: IssueRun | null): string {
  if (!run) return "unknown";
  return run.ended_at === "" ? "open" : "ended";
}

export function supervisorSessionStatus(input: {
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

export function staleSession(
  session: AgentSession | null,
  activityUpdatedAt: string | undefined,
  now: Date,
  staleAfterSeconds: number
): boolean {
  if (!session) return false;
  return stoppedSession(session) || ageSeconds(latestTimestamp(session.updated_at, activityUpdatedAt), now) >= staleAfterSeconds;
}

export function latestTimestamp(...values: Array<string | undefined>): string {
  return values.reduce<string>((latest, value) => {
    const candidate = Date.parse(value ?? "");
    return Number.isFinite(candidate) && candidate > Date.parse(latest || "1970-01-01T00:00:00Z")
      ? value ?? latest
      : latest;
  }, "");
}

export function activeStatus(value: string): boolean {
  return ["running", "inprogress", "started", "active"].includes(value.trim().toLowerCase());
}

export function stoppedSession(session: AgentSession | null): boolean {
  return session ? stoppedStatus(session.status) : false;
}

export function blocksStoppedRecovery(providerError: ProviderErrorSignal | null): boolean {
  return ["auth", "permission", "quota"].includes(cleanString(providerError?.category));
}

export function stoppedStatus(value: string): boolean {
  return ["idle", "stopped", "completed", "done", "failed", "error"].includes(value.trim().toLowerCase());
}

export function normalizedStoppedStatus(value: string): string {
  const status = value.trim().toLowerCase();
  if (status === "completed" || status === "done") return "idle";
  if (status === "failed" || status === "error") return "failed";
  return status || "idle";
}

export function consecutiveNoProgress(events: IssueSupervisorEvent[]): number {
  let count = 0;
  for (const event of [...events].reverse()) {
    if (outcome(event) !== "no_progress") break;
    count += 1;
  }
  return count;
}

export function outcome(event: IssueSupervisorEvent | undefined): string {
  return cleanString(objectValue(parsePayload(event?.payload_json ?? "{}")).outcome);
}

export function isRecoveryAction(event: IssueSupervisorEvent): boolean {
  return event.event_type === "action" && RECOVERY_ACTIONS.has(event.action_type);
}
