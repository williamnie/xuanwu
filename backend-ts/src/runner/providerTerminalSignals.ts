import { getAgentSession } from "../db/repositories/agentSessions.ts";
import { getIssue, listIssueRuns, type Issue, type IssueRun } from "../db/repositories/issues.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { ProviderEvent } from "../providers/types.ts";
import { guardianSignalsFromSupervisorCandidates, writeGuardianSignals } from "../pi/guardianSignals.ts";
import type { HeartbeatSupervisorCandidateSignal } from "../pi/heartbeatTypes.ts";
import {
  parseIssueEventProviderError,
  parseProviderEventError,
  type ProviderErrorSignal
} from "../pi/providerErrorParser.ts";

export type ProviderTerminalSignalInput = {
  activeRunID: string;
  database: RunnerDatabase;
  event: ProviderEvent;
  issueEventID?: number;
  issueID: number;
  projectID: string;
  now?: Date;
};
export type ProviderTerminalBackfillOptions = { limit?: number; now?: Date };
export type ProviderTerminalBackfillSummary = { scanned: number; signaled: number; skipped: number };

const PROVIDER_TERMINAL_ACTIONS = ["session.resume_followup", "issue.retry", "issue.retry_after", "needs_user.escalate"];
const DEFAULT_BACKFILL_LIMIT = 50;

export function signalProviderTerminalEvent(input: ProviderTerminalSignalInput): void {
  if (!terminalProviderEvent(input.event)) return;
  const now = input.now ?? new Date();
  const signal = parseProviderEventError(input.event, { now });
  const diagnosis = clean(signal.diagnosis_code);
  if (diagnosis === "") return;
  const issue = getIssue(input.database, input.issueID);
  if (!issue) return;
  const run = latestRun(input.database, input.issueID, input.activeRunID);
  const provider = clean(input.event.provider || signal.provider || run?.provider) || "codex";
  const sessionID = clean(input.event.session?.sessionId || run?.provider_session_id || issue.codex_thread_id);
  const session = sessionID === "" ? null : getAgentSession(input.database, `${provider}:${sessionID}`);
  writeProviderTerminalSignal(input.database, {
    diagnosis,
    issue,
    projectID: input.projectID,
    provider,
    reason: signal.raw_summary,
    run,
    sessionID,
    sessionStatus: clean(session?.status || input.event.status),
    sessionUpdatedAt: clean(session?.updated_at),
    sourceID: signalSourceID(input, diagnosis, sessionID),
    signal,
    turnID: clean(input.event.session?.turnId || run?.provider_turn_id || issue.codex_turn_id)
  }, now);
}

export function signalOpenRunTerminalProviderErrors(
  db: RunnerDatabase,
  options: ProviderTerminalBackfillOptions = {}
): ProviderTerminalBackfillSummary {
  const now = options.now ?? new Date();
  const rows = openRunRows(db, options.limit ?? DEFAULT_BACKFILL_LIMIT);
  const summary: ProviderTerminalBackfillSummary = { scanned: rows.length, signaled: 0, skipped: 0 };
  for (const row of rows) {
    const backfill = latestTerminalSignal(db, row.issue_id, row.run_started_at, now);
    if (!backfill) {
      summary.skipped += 1;
      continue;
    }
    const sourceID = logSignalSourceID(
      { issueID: row.issue_id, projectID: row.project_id },
      backfill.eventID,
      clean(backfill.signal.diagnosis_code)
    );
    if (guardianSignalExists(db, sourceID)) {
      summary.skipped += 1;
      continue;
    }
    writeProviderTerminalSignal(db, snapshotFromOpenRun(row, backfill.signal, sourceID), now);
    summary.signaled += 1;
  }
  return summary;
}

type TerminalSignalSnapshot = {
  diagnosis: string;
  issue: Issue;
  projectID: string;
  provider: string;
  reason: string;
  run: IssueRun | null;
  sessionID: string;
  sessionStatus: string;
  sessionUpdatedAt: string;
  signal: ProviderErrorSignal;
  sourceID: string;
  turnID: string;
};

function writeProviderTerminalSignal(
  db: RunnerDatabase,
  snapshot: TerminalSignalSnapshot,
  now: Date
): void {
  writeGuardianSignals(db, guardianSignalsFromSupervisorCandidates([{
    allowed_actions: PROVIDER_TERMINAL_ACTIONS,
    budget_remaining: 1,
    diagnosis_code: snapshot.diagnosis,
    evidence_refs: ["provider_event", "issue.log", "latest_run", "session"],
    issue_id: snapshot.issue.id,
    issue_status: snapshot.issue.status,
    issue_updated_at: snapshot.issue.updated_at,
    project_budget_remaining: 1,
    project_id: snapshot.projectID,
    provider: snapshot.provider,
    provider_error_category: snapshot.signal.category,
    provider_session_id: snapshot.sessionID,
    provider_turn_id: snapshot.turnID,
    ready: true,
    reason: snapshot.reason,
    run_ended_at: clean(snapshot.run?.ended_at),
    run_id: clean(snapshot.run?.id),
    run_status: clean(snapshot.run?.status),
    session_status: snapshot.sessionStatus,
    session_turn_id: snapshot.turnID,
    session_updated_at: snapshot.sessionUpdatedAt,
    stale_gap_seconds: 0,
    supervisor_mode: "autonomous",
    wait_until: clean(snapshot.signal.retry_after_at)
  } satisfies HeartbeatSupervisorCandidateSignal], {
    heartbeatID: snapshot.sourceID,
    now,
    projectID: snapshot.projectID
  }));
}

function terminalProviderEvent(event: ProviderEvent): boolean {
  const method = clean(event.raw?.method);
  const status = clean(event.status).toLowerCase();
  if (event.type === "error") return true;
  if (method === "turn/completed" && status !== "" && status !== "completed") return true;
  return method === "thread/status/changed" && ["systemerror", "failed", "error"].includes(status);
}

function latestRun(db: RunnerDatabase, issueID: number, activeRunID: string): IssueRun | null {
  const runs = listIssueRuns(db, issueID);
  return runs.find((run) => run.id === activeRunID) ?? runs.at(-1) ?? null;
}

type OpenRunRow = {
  codex_thread_id: string; codex_turn_id: string; issue_id: number; issue_status: string;
  issue_updated_at: string; project_id: string; provider: string; provider_session_id: string;
  provider_turn_id: string; run_ended_at: string; run_id: string; run_started_at: string; run_status: string;
  session_status: string; session_updated_at: string;
};

type IssueLogRow = { created_at: string; id: number; payload: string };
type BackfillSignal = { eventID: number; signal: ProviderErrorSignal };

function openRunRows(db: RunnerDatabase, limit: number): OpenRunRow[] {
  return db.sqlite.query<OpenRunRow, []>(`
    select i.id as issue_id, i.project_id, i.status as issue_status,
      i.updated_at as issue_updated_at, i.codex_thread_id, i.codex_turn_id,
      coalesce(ir.id, '') as run_id, coalesce(ir.provider, '') as provider,
      coalesce(ir.provider_session_id, '') as provider_session_id,
      coalesce(ir.provider_turn_id, '') as provider_turn_id,
      coalesce(ir.status, '') as run_status, coalesce(ir.started_at, '') as run_started_at,
      coalesce(ir.ended_at, '') as run_ended_at,
      coalesce(s.status, '') as session_status, coalesce(s.updated_at, '') as session_updated_at
    from issues i
    join issue_runs ir on ir.issue_id=i.id and ir.ended_at=''
    left join agent_sessions s on s.session_key=(coalesce(nullif(ir.provider, ''), 'codex') || ':' ||
      coalesce(nullif(ir.provider_session_id, ''), i.codex_thread_id))
    where i.status='in_progress'
    order by i.updated_at asc, i.id asc
    limit ${boundedLimit(limit)}
  `).all();
}

function latestTerminalSignal(db: RunnerDatabase, issueID: number, runStartedAt: string, now: Date): BackfillSignal | null {
  const rows = db.sqlite.query<IssueLogRow, [number, string]>(`
    select id, payload, created_at from issue_events
    where issue_id=? and type='issue.log' and created_at>=?
    order by id desc limit 10
  `).all(issueID, runStartedAt);
  for (const row of rows) {
    const payload = parseJsonRecord(row.payload);
    if (!terminalIssueLog(payload)) continue;
    const signal = parseIssueEventProviderError(payload, { now });
    if (clean(signal.diagnosis_code) !== "") return { eventID: row.id, signal };
  }
  return null;
}

function snapshotFromOpenRun(
  row: OpenRunRow,
  signal: ProviderErrorSignal,
  sourceID: string
): TerminalSignalSnapshot {
  const issue = issueFromOpenRun(row);
  const provider = clean(signal.provider || row.provider) || "codex";
  const sessionID = clean(row.provider_session_id || row.codex_thread_id);
  const turnID = clean(row.provider_turn_id || row.codex_turn_id);
  return {
    diagnosis: clean(signal.diagnosis_code),
    issue,
    projectID: row.project_id,
    provider,
    reason: signal.raw_summary,
    run: runFromOpenRun(row),
    sessionID,
    sessionStatus: clean(row.session_status),
    sessionUpdatedAt: clean(row.session_updated_at),
    signal,
    sourceID,
    turnID
  };
}

function issueFromOpenRun(row: OpenRunRow): Issue {
  return {
    id: row.issue_id,
    project_id: row.project_id,
    status: row.issue_status,
    updated_at: row.issue_updated_at
  } as Issue;
}

function runFromOpenRun(row: OpenRunRow): IssueRun {
  return {
    ended_at: row.run_ended_at,
    id: row.run_id,
    issue_id: row.issue_id,
    provider: row.provider,
    provider_session_id: row.provider_session_id,
    provider_turn_id: row.provider_turn_id,
    status: row.run_status
  } as IssueRun;
}

function terminalIssueLog(payload: Record<string, unknown>): boolean {
  const method = clean(payload.raw_method);
  const status = clean(payload.status).toLowerCase();
  if (clean(payload.type).toLowerCase() === "error") return true;
  if (method === "turn/completed" && status !== "" && status !== "completed") return true;
  return method === "thread/status/changed" && ["systemerror", "failed", "error"].includes(status);
}

function guardianSignalExists(db: RunnerDatabase, sourceID: string): boolean {
  const row = db.sqlite.query<{ count: number }, [string]>(
    "select count(*) as count from pi_guardian_event_inbox where source='supervisor' and source_event_id=?"
  ).get(sourceID);
  return (row?.count ?? 0) > 0;
}

function signalSourceID(input: ProviderTerminalSignalInput, diagnosis: string, sessionID: string): string {
  if (positiveInteger(input.issueEventID) > 0) return logSignalSourceID(input, input.issueEventID ?? 0, diagnosis);
  return [
    "provider-terminal",
    input.projectID,
    input.issueID,
    clean(input.event.raw?.method || input.event.type) || "event",
    sessionID || "no-session",
    clean(input.event.session?.turnId) || "no-turn",
    diagnosis
  ].join(":");
}

function logSignalSourceID(
  input: Pick<ProviderTerminalSignalInput, "issueID" | "projectID">,
  eventID: number,
  diagnosis: string
): string {
  return ["provider-terminal-log", input.projectID, input.issueID, eventID, diagnosis || "unknown"].join(":");
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function boundedLimit(value: number): number {
  return Math.min(Math.max(Number.isFinite(value) ? Math.round(value) : DEFAULT_BACKFILL_LIMIT, 1), DEFAULT_BACKFILL_LIMIT);
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
