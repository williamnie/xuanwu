import { getAgentSession, listAgentSessions, type AgentSession } from "../../db/repositories/agentSessions.ts";
import type { RunnerDatabase } from "../../db/database.ts";
import { getIssue, listIssueRuns, type Issue, type IssueRun } from "../../db/repositories/issues.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { cleanString } from "../../util/values.ts";

export type IssueStateSnapshot = {
  issue: {
    codex_thread_id: string;
    codex_turn_id: string;
    error: string;
    id: number;
    project_id: string;
    status: string;
    updated_at: string;
  };
  run: {
    ended_at: string;
    id: string;
    provider: string;
    provider_session_id: string;
    provider_turn_id: string;
    started_at: string;
    status: string;
  } | null;
  session: {
    provider: string;
    provider_session_id: string;
    session_key: string;
    status: string;
    updated_at: string;
  } | null;
};

const ISSUE_KEYS = ["codex_thread_id", "codex_turn_id", "error", "id", "project_id", "status", "updated_at"];
const RUN_KEYS = ["ended_at", "id", "provider", "provider_session_id", "provider_turn_id", "started_at", "status"];
const SESSION_KEYS = ["provider", "provider_session_id", "session_key", "status", "updated_at"];
const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g;

export function currentIssueStateSnapshot(db: RunnerDatabase, issueID: number): IssueStateSnapshot {
  const issue = getIssue(db, issueID);
  if (!issue) throw new Error(`issue ${issueID} not found`);
  const run = listIssueRuns(db, issue.id).at(-1);
  return issueStateSnapshot(issue, run, currentIssueSession(db, issue, run));
}

export function issueStateSnapshot(
  issue: Issue,
  run: IssueRun | undefined,
  session: AgentSession | undefined
): IssueStateSnapshot {
  return {
    issue: {
      codex_thread_id: cleanString(issue.codex_thread_id),
      codex_turn_id: cleanString(issue.codex_turn_id),
      error: safeText(issue.error),
      id: issue.id,
      project_id: cleanString(issue.project_id),
      status: cleanString(issue.status),
      updated_at: cleanString(issue.updated_at)
    },
    run: run ? {
      ended_at: cleanString(run.ended_at),
      id: cleanString(run.id),
      provider: cleanString(run.provider),
      provider_session_id: cleanString(run.provider_session_id),
      provider_turn_id: cleanString(run.provider_turn_id),
      started_at: cleanString(run.started_at),
      status: cleanString(run.status)
    } : null,
    session: session ? {
      provider: cleanString(session.provider),
      provider_session_id: cleanString(session.provider_session_id),
      session_key: cleanString(session.session_key),
      status: cleanString(session.status),
      updated_at: cleanString(session.updated_at)
    } : null
  };
}

export function normalizeIssueStateSnapshot(value: unknown): IssueStateSnapshot {
  const input = objectPayload(value, "expected_state");
  requireKeys(input, ["issue", "run", "session"], "expected_state");
  return {
    issue: normalizeIssueSnapshot(input.issue),
    run: input.run === null ? null : normalizeRunSnapshot(input.run),
    session: input.session === null ? null : normalizeSessionSnapshot(input.session)
  };
}

export function issueStateSnapshotsEqual(left: IssueStateSnapshot, right: IssueStateSnapshot): boolean {
  return stableJson(left) === stableJson(right);
}

export function issueStateSnapshotDiff(expected: IssueStateSnapshot, actual: IssueStateSnapshot): string {
  if (stableJson(expected.issue) !== stableJson(actual.issue)) return "issue";
  if (stableJson(expected.run) !== stableJson(actual.run)) return "run";
  if (stableJson(expected.session) !== stableJson(actual.session)) return "session";
  return "unknown";
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function currentIssueSession(
  db: RunnerDatabase,
  issue: Issue,
  run: IssueRun | undefined
): AgentSession | undefined {
  const exact = exactRunSession(db, run);
  if (exact) return exact;
  return listAgentSessions(db, { projectId: issue.project_id }).find((session) =>
    session.issue_id === issue.id || (
      issue.codex_thread_id !== "" &&
      session.provider === "codex" &&
      session.provider_session_id === issue.codex_thread_id
    )
  );
}

function exactRunSession(db: RunnerDatabase, run: IssueRun | undefined): AgentSession | undefined {
  if (!run || run.provider === "" || run.provider_session_id === "") return undefined;
  return getAgentSession(db, `${run.provider}:${run.provider_session_id}`) ?? undefined;
}

function normalizeIssueSnapshot(value: unknown): IssueStateSnapshot["issue"] {
  const input = objectPayload(value, "expected_state.issue");
  requireKeys(input, ISSUE_KEYS, "expected_state.issue");
  return {
    codex_thread_id: cleanString(input.codex_thread_id),
    codex_turn_id: cleanString(input.codex_turn_id),
    error: safeText(input.error),
    id: positiveID(input.id, "expected_state.issue.id"),
    project_id: cleanString(input.project_id),
    status: cleanString(input.status),
    updated_at: cleanString(input.updated_at)
  };
}

function normalizeRunSnapshot(value: unknown): IssueStateSnapshot["run"] {
  const input = objectPayload(value, "expected_state.run");
  requireKeys(input, RUN_KEYS, "expected_state.run");
  return {
    ended_at: cleanString(input.ended_at),
    id: cleanString(input.id),
    provider: cleanString(input.provider),
    provider_session_id: cleanString(input.provider_session_id),
    provider_turn_id: cleanString(input.provider_turn_id),
    started_at: cleanString(input.started_at),
    status: cleanString(input.status)
  };
}

function normalizeSessionSnapshot(value: unknown): IssueStateSnapshot["session"] {
  const input = objectPayload(value, "expected_state.session");
  requireKeys(input, SESSION_KEYS, "expected_state.session");
  return {
    provider: cleanString(input.provider),
    provider_session_id: cleanString(input.provider_session_id),
    session_key: cleanString(input.session_key),
    status: cleanString(input.status),
    updated_at: cleanString(input.updated_at)
  };
}

function objectPayload(value: unknown, label: string): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error(`${label} must be an object`);
}

function requireKeys(input: Record<string, unknown>, keys: readonly string[], label: string): void {
  const missing = keys.filter((key) => !Object.hasOwn(input, key));
  if (missing.length > 0) throw new Error(`${label} missing fields: ${missing.join(", ")}`);
}

function positiveID(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  throw new Error(`${label} must be positive`);
}

function safeText(value: unknown): string {
  return redactSensitiveText(cleanString(value)).replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]");
}
