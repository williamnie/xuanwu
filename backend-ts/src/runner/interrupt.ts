import { cancelIssue } from "../db/repositories/issueActions.ts";
import { getAgentSession } from "../db/repositories/agentSessions.ts";
import { issueTimestamp } from "../db/repositories/issueCreate.ts";
import { getIssue, listIssues, type Issue } from "../db/repositories/issues.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { redactSensitiveText } from "../util/redact.ts";
import type { AppEvent, EventBus } from "../events/bus.ts";
import type { ExecutorProvider, ExecutorProviderId, InterruptInput, SessionRef } from "../providers/types.ts";

export type InterruptRuntime = {
  bus?: EventBus;
  interruptTimeoutMs?: number;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};

export type SessionInterruptResult = {
  interrupted: boolean;
  issue?: Issue;
};

const DEFAULT_INTERRUPT_TIMEOUT_MS = 2000;
const ISSUE_CANCEL_REASON = "issue_cancel";
const SESSION_INTERRUPT_REASON = "session_interrupt";

export async function cancelIssueWithInterrupt(
  db: RunnerDatabase,
  issueID: number,
  runtime: InterruptRuntime = {}
): Promise<Issue> {
  const issue = mustGetIssue(db, issueID);
  if (shouldInterruptIssue(issue)) {
    await interruptLinkedIssue(db, issue, ISSUE_CANCEL_REASON, runtime);
  }
  return cancelIssue(db, issueID, ISSUE_CANCEL_REASON);
}

export async function interruptSession(
  db: RunnerDatabase,
  rawSessionID: string,
  runtime: InterruptRuntime = {}
): Promise<SessionInterruptResult> {
  const session = sessionRef(rawSessionID, latestTurnID(db, rawSessionID));
  const linked = linkedRunningIssue(db, session.sessionId);
  if (linked) {
    await interruptLinkedIssue(db, linked, SESSION_INTERRUPT_REASON, runtime);
    return { interrupted: true, issue: cancelIssue(db, linked.id, SESSION_INTERRUPT_REASON) };
  }
  if (!session.turnId) return { interrupted: false };
  await interruptProviderTurn(db, 0, session, SESSION_INTERRUPT_REASON, runtime);
  return { interrupted: true };
}

function shouldInterruptIssue(issue: Issue): boolean {
  return issue.status === "in_progress" && issue.codex_thread_id !== "" && issue.codex_turn_id !== "";
}

async function interruptLinkedIssue(
  db: RunnerDatabase,
  issue: Issue,
  reason: string,
  runtime: InterruptRuntime
): Promise<void> {
  const session = sessionRef(issue.codex_thread_id, issue.codex_turn_id);
  recordInterruptEvent(db, issue.id, "issue.interrupt_requested", session, reason, runtime.bus);
  await interruptProviderTurn(db, issue.id, session, reason, runtime);
  recordInterruptEvent(db, issue.id, "issue.interrupted", session, reason, runtime.bus);
}

async function interruptProviderTurn(
  db: RunnerDatabase,
  issueID: number,
  session: SessionRef,
  reason: string,
  runtime: InterruptRuntime
): Promise<void> {
  const provider = runtime.providers?.[session.provider];
  if (!provider?.interrupt) return;
  const error = await interruptWithTimeout(provider, { session, reason }, runtime.interruptTimeoutMs);
  if (error && issueID > 0) {
    recordInterruptFailed(db, issueID, session, reason, safeError(error), runtime.bus);
  }
}

async function interruptWithTimeout(
  provider: Pick<ExecutorProvider, "interrupt">,
  input: InterruptInput,
  timeoutMs = DEFAULT_INTERRUPT_TIMEOUT_MS
): Promise<Error | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      provider.interrupt?.(input),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("provider interrupt timed out")), Math.max(1, timeoutMs));
      })
    ]);
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function linkedRunningIssue(db: RunnerDatabase, threadID: string): Issue | null {
  return listIssues(db, { status: "in_progress" }).find((issue) => {
    return issue.codex_thread_id === threadID && issue.codex_turn_id !== "";
  }) ?? null;
}

function latestTurnID(db: RunnerDatabase, rawSessionID: string): string {
  const key = normalizeSessionKey(rawSessionID);
  const session = getAgentSession(db, key);
  return rawRefTurnID(session?.raw_ref);
}

function rawRefTurnID(rawRef: string | undefined): string {
  if (!rawRef) return "";
  try {
    const parsed = JSON.parse(rawRef) as Record<string, unknown>;
    return typeof parsed.provider_turn_id === "string" ? parsed.provider_turn_id.trim() : "";
  } catch {
    return "";
  }
}

function normalizeSessionKey(rawSessionID: string): string {
  const clean = rawSessionID.trim();
  return clean.includes(":") ? clean : `codex:${clean}`;
}

function sessionRef(rawSessionID: string, turnID: string): SessionRef {
  const key = normalizeSessionKey(rawSessionID);
  const separator = key.indexOf(":");
  const provider = key.slice(0, separator) as ExecutorProviderId;
  return { provider, sessionId: key.slice(separator + 1), ...(turnID === "" ? {} : { turnId: turnID }) };
}

function recordInterruptEvent(
  db: RunnerDatabase,
  issueID: number,
  type: string,
  session: SessionRef,
  reason: string,
  bus?: EventBus
): void {
  recordEvent(db, issueID, type, {
    thread_id: session.sessionId,
    turn_id: session.turnId ?? "",
    reason
  }, bus, session);
}

function recordInterruptFailed(
  db: RunnerDatabase,
  issueID: number,
  session: SessionRef,
  reason: string,
  error: string,
  bus?: EventBus
): void {
  recordEvent(db, issueID, "issue.interrupt_failed", {
    thread_id: session.sessionId,
    turn_id: session.turnId ?? "",
    reason,
    error
  }, bus, session, error);
}

function recordEvent(
  db: RunnerDatabase,
  issueID: number,
  type: string,
  payload: Record<string, string>,
  bus: EventBus | undefined,
  session: SessionRef,
  error = ""
): void {
  const createdAt = issueTimestamp();
  const payloadJSON = JSON.stringify(payload);
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, type, payloadJSON, createdAt]
  );
  publish(bus, {
    id: lastInsertID(db),
    type,
    issueId: issueID,
    threadId: session.sessionId,
    turnId: session.turnId ?? "",
    error,
    payload: payloadJSON,
    created_at: createdAt
  });
}

function publish(bus: EventBus | undefined, event: AppEvent): void {
  bus?.publish(event);
}

function lastInsertID(db: RunnerDatabase): number {
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  return row?.id ?? 0;
}

function mustGetIssue(db: RunnerDatabase, id: number): Issue {
  const issue = getIssue(db, id);
  if (!issue) throw new Error("资源不存在");
  return issue;
}

function safeError(error: Error): string {
  return redactSensitiveText(error.message);
}
