import type { RunnerDatabase } from "../db/database.ts";
import { getAgentSession } from "../db/repositories/agentSessions.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import type { Issue, IssueRun } from "../db/repositories/issues.ts";
import type { ExecutorProviderId } from "../providers/types.ts";

export function assertFreshSupervisorState(
  db: RunnerDatabase,
  issueID: number,
  provider: ExecutorProviderId,
  sessionID: string,
  payload: Record<string, unknown>,
  requiredKeys: string[] = [],
  mode: "strict" | "resume_revalidate" | "retry_revalidate" = "strict"
): void {
  const issue = getIssue(db, issueID);
  if (!issue) throw new Error(`issue ${issueID} not found`);
  const latestRun = listIssueRuns(db, issueID).at(-1);
  assertPreconditionsPresent(payload, requiredKeys);
  assertIssueSnapshot(issue, payload, mode);
  assertRunSnapshot(latestRun, payload, mode, provider, sessionID);
  if (sessionID !== "") assertSessionSnapshot(db, provider, sessionID, payload, mode);
}

function assertPreconditionsPresent(payload: Record<string, unknown>, keys: string[]): void {
  const missing = keys.filter((key) => clean(payload[key]) === "");
  if (missing.length > 0) throw new Error(`supervisor action precondition missing: ${missing.join(", ")}`);
}

function assertIssueSnapshot(
  issue: Issue,
  payload: Record<string, unknown>,
  mode: "strict" | "resume_revalidate" | "retry_revalidate"
): void {
  if (mode === "strict") {
    assertExpected("issue changed before PI action execution", payload.expected_issue_updated_at, issue.updated_at);
  } else if (mode === "resume_revalidate" && issue.status !== "in_progress") {
    throw new Error("issue changed before PI action execution");
  }
  assertExpected("issue changed before PI action execution", payload.expected_issue_status, issue.status);
}

function assertRunSnapshot(
  run: IssueRun | undefined,
  payload: Record<string, unknown>,
  mode: "strict" | "resume_revalidate" | "retry_revalidate",
  provider: ExecutorProviderId,
  sessionID: string
): void {
  const expectedRunID = clean(payload.expected_run_id);
  if (expectedRunID !== "" && run?.id !== expectedRunID) throw new Error("run changed before PI action execution");
  assertExpected("run changed before PI action execution", payload.expected_provider_session_id, run?.provider_session_id ?? "");
  assertExpected("run changed before PI action execution", payload.expected_provider_turn_id, run?.provider_turn_id ?? "");
  assertExpected("run changed before PI action execution", payload.expected_run_status, run?.status ?? "");
  assertExpected("run changed before PI action execution", payload.expected_run_ended_at, run?.ended_at ?? "");
  if (mode === "resume_revalidate" && (!run || run.status !== "in_progress" || run.ended_at !== "")) {
    throw new Error("run changed before PI action execution");
  }
  if (mode === "resume_revalidate" &&
    (run?.provider !== provider || run.provider_session_id !== sessionID)) {
    throw new Error("run changed before PI action execution");
  }
}

function assertSessionSnapshot(
  db: RunnerDatabase,
  provider: ExecutorProviderId,
  sessionID: string,
  payload: Record<string, unknown>,
  mode: "strict" | "resume_revalidate" | "retry_revalidate"
): void {
  const session = getAgentSession(db, `${provider}:${sessionID}`);
  if (!session) throw new Error("session changed before PI action execution");
  if (mode === "strict") {
    assertExpected("session changed before PI action execution", payload.expected_session_updated_at, session.updated_at);
  }
  assertExpected("session changed before PI action execution", payload.expected_session_status, session?.status ?? "");
  const sessionTurnID = rawRefTurnID(session?.raw_ref);
  assertExpected("session changed before PI action execution", payload.expected_session_turn_id, sessionTurnID);
  const expectedProviderTurnID = clean(payload.expected_provider_turn_id);
  if (mode === "resume_revalidate" && sessionTurnID !== "" &&
    expectedProviderTurnID !== "" && sessionTurnID !== expectedProviderTurnID) {
    throw new Error("session changed before PI action execution");
  }
}

function assertExpected(message: string, expected: unknown, actual: string): void {
  const text = clean(expected);
  if (text !== "" && text !== actual) throw new Error(message);
}

function rawRefTurnID(rawRef: string | undefined): string {
  if (!rawRef) return "";
  try { return clean((JSON.parse(rawRef) as Record<string, unknown>).provider_turn_id); } catch { return ""; }
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
