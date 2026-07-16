import type { RunnerDatabase } from "../db/database.ts";
import { getAgentSession, listAgentSessions, type AgentSession } from "../db/repositories/agentSessions.ts";
import { hydrateStoredIssueLogPayload } from "../db/repositories/issueEvents.ts";
import { getIssue, type Issue } from "../db/repositories/issues.ts";
import { redactSensitiveText } from "../util/redact.ts";

export type SessionProgressState = "active" | "done" | "error" | "unknown";

export type SessionProgressEvent = {
  created_at: string;
  issue_id: number;
  source: "issue_event" | "issue_run";
  status: string;
  summary: string;
  type: string;
};

export type SessionProgressSummary = {
  agent_role: string;
  issue_id: number;
  last_activity_at: string;
  progress_state: SessionProgressState;
  provider: string;
  provider_session_id: string;
  recent_events: SessionProgressEvent[];
  run_status: string;
  session_key: string;
  status: string;
  summary: string;
  title: string;
  updated_at: string;
};

export type SessionObserverOptions = { limit?: number };

type RunRow = {
  attempt: unknown; ended_at: unknown; error: unknown; exit_reason: unknown; id: unknown;
  issue_id: unknown; started_at: unknown; status: unknown;
};
type EventRow = { created_at: unknown; issue_id: unknown; payload: unknown; type: unknown };
type RunRecord = ReturnType<typeof mapRunRow>;

const DEFAULT_LIMIT = 6;
const EVENT_SUMMARY_LIMIT = 150;
const SESSION_SUMMARY_LIMIT = 260;
const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g;

export function observeSessionProgress(
  db: RunnerDatabase,
  sessionKey: string,
  options: SessionObserverOptions = {}
): SessionProgressSummary {
  const session = getAgentSession(db, sessionKey.trim());
  if (!session) throw new Error("session 不存在");
  return buildSessionProgress(db, session, eventLimit(options));
}

export function listProjectSessionProgress(
  db: RunnerDatabase,
  projectID: string,
  options: SessionObserverOptions = {}
): SessionProgressSummary[] {
  const limit = eventLimit(options);
  return listAgentSessions(db, { projectId: projectID.trim() })
    .slice(0, limit)
    .map((session) => buildSessionProgress(db, session, limit));
}

function buildSessionProgress(db: RunnerDatabase, session: AgentSession, limit: number): SessionProgressSummary {
  const issue = session.issue_id > 0 ? getIssue(db, session.issue_id) : null;
  const runs = listSessionRuns(db, session, limit);
  const recentEvents = mergeRecentEvents(runs, listSessionEvents(db, session.issue_id, limit), limit);
  const latestRun = runs[0];
  const progressState = classifyProgress(session, issue, latestRun, recentEvents);
  return {
    agent_role: session.agent_role,
    issue_id: session.issue_id,
    last_activity_at: lastActivity(session, latestRun, recentEvents),
    progress_state: progressState,
    provider: session.provider,
    provider_session_id: session.provider_session_id,
    recent_events: recentEvents,
    run_status: latestRun?.status ?? "",
    session_key: session.session_key,
    status: session.status || "unknown",
    summary: sessionSummary(session, issue, latestRun, recentEvents, progressState),
    title: cleanText(session.title || issue?.title || session.provider_session_id),
    updated_at: session.updated_at
  };
}

function listSessionRuns(db: RunnerDatabase, session: AgentSession, limit: number): RunRecord[] {
  return db.sqlite.query<RunRow, Array<number | string>>(`
    select id, issue_id, attempt, status, started_at, ended_at, exit_reason, error
    from issue_runs where (provider=? and provider_session_id=?)
      or (? > 0 and issue_id=? and provider_session_id='')
    order by coalesce(nullif(ended_at, ''), started_at) desc, attempt desc limit ?
  `).all(session.provider, session.provider_session_id, session.issue_id, session.issue_id, limit).map(mapRunRow);
}

function listSessionEvents(db: RunnerDatabase, issueID: number, limit: number): SessionProgressEvent[] {
  if (issueID <= 0) return [];
  return db.sqlite.query<EventRow, [number, number]>(`
    select issue_id, type, payload, created_at from issue_events
    where issue_id=? order by created_at desc, id desc limit ?
  `).all(issueID, limit).map((row) => mapIssueEvent(db, row));
}

function mapRunRow(row: RunRow) {
  return {
    attempt: integerValue(row.attempt),
    ended_at: optionalString(row.ended_at),
    error: cleanText(optionalString(row.error)),
    exit_reason: cleanText(optionalString(row.exit_reason)),
    id: optionalString(row.id),
    issue_id: integerValue(row.issue_id),
    started_at: optionalString(row.started_at),
    status: optionalString(row.status, "unknown")
  };
}

function mapIssueEvent(db: RunnerDatabase, row: EventRow): SessionProgressEvent {
  const storedPayload = optionalString(row.payload);
  const payload = parsePayload(optionalString(row.type) === "issue.log"
    ? hydrateStoredIssueLogPayload(db, storedPayload)
    : storedPayload);
  const type = optionalString(payload.type) || optionalString(row.type, "issue.log");
  const status = optionalString(payload.status);
  return {
    created_at: optionalString(row.created_at),
    issue_id: integerValue(row.issue_id),
    source: "issue_event",
    status,
    summary: eventSummary(type, payload),
    type
  };
}

function mergeRecentEvents(runs: RunRecord[], events: SessionProgressEvent[], limit: number): SessionProgressEvent[] {
  const runEvents = runs.map((run) => ({
    created_at: run.ended_at || run.started_at,
    issue_id: run.issue_id,
    source: "issue_run" as const,
    status: run.status,
    summary: runSummary(run),
    type: "issue_run"
  }));
  return [...runEvents, ...events]
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .slice(0, limit);
}

function classifyProgress(
  session: AgentSession,
  issue: Issue | null,
  latestRun: RunRecord | undefined,
  events: SessionProgressEvent[]
): SessionProgressState {
  const statuses = [session.status, issue?.status ?? "", latestRun?.status ?? ""];
  if (statuses.some(isErrorStatus) || latestRun?.error) return "error";
  if (statuses.some(isActiveStatus)) return "active";
  if (statuses.some(isDoneStatus)) return "done";
  return events.some((event) => isErrorStatus(event.status) || /error|failed/i.test(event.type)) ? "error" : "unknown";
}

function sessionSummary(
  session: AgentSession,
  issue: Issue | null,
  latestRun: RunRecord | undefined,
  events: SessionProgressEvent[],
  state: SessionProgressState
): string {
  const parts = [`${session.provider} session ${session.provider_session_id}`, `state=${state}`];
  if (issue) parts.push(`issue #${issue.id} ${issue.status}`);
  if (latestRun) parts.push(`latest run ${latestRun.status}`);
  if (events[0]?.summary) parts.push(`last: ${events[0].summary}`);
  return cleanText(parts.join("; "), SESSION_SUMMARY_LIMIT);
}

function runSummary(run: RunRecord): string {
  const detail = run.error || run.exit_reason;
  const base = `run attempt ${run.attempt} ${run.status}`;
  return detail ? cleanText(`${base}: ${detail}`, EVENT_SUMMARY_LIMIT) : base;
}

function eventSummary(type: string, payload: Record<string, unknown>): string {
  const text = firstText(payload, ["error", "message", "text", "command", "path"]);
  const prefix = type.includes("error") || payload.error ? "error" : type;
  return cleanText(text ? `${prefix}: ${text}` : prefix, EVENT_SUMMARY_LIMIT);
}

function firstText(payload: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = optionalString(payload[key]);
    if (value !== "") return value;
  }
  return "";
}

function lastActivity(
  session: AgentSession,
  latestRun: RunRecord | undefined,
  events: SessionProgressEvent[]
): string {
  return [session.updated_at, latestRun?.ended_at ?? "", latestRun?.started_at ?? "", events[0]?.created_at ?? ""]
    .filter(Boolean)
    .sort()
    .at(-1) ?? session.updated_at;
}

function parsePayload(payload: string): Record<string, unknown> {
  if (payload === "") return {};
  try {
    const parsed = JSON.parse(payload) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return { text: payload };
  }
}

function eventLimit(options: SessionObserverOptions): number {
  const limit = options.limit ?? DEFAULT_LIMIT;
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, 20) : DEFAULT_LIMIT;
}

function isActiveStatus(value: string): boolean {
  return ["active", "busy", "inprogress", "running"].includes(normalizeStatus(value));
}

function isDoneStatus(value: string): boolean {
  return ["completed", "done", "success", "succeeded"].includes(normalizeStatus(value));
}

function isErrorStatus(value: string): boolean {
  return ["error", "failed", "failure"].includes(normalizeStatus(value));
}

function normalizeStatus(value: string): string {
  return value.toLowerCase().replace(/[_\s-]/g, "");
}

function cleanText(value: string, limit = EVENT_SUMMARY_LIMIT): string {
  const redacted = redactSensitiveText(value)
    .replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]")
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length > limit ? `${redacted.slice(0, limit - 1)}…` : redacted;
}

function optionalString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function integerValue(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}
