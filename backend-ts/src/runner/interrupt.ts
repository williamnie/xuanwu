import {
  cancelIssue,
  forceRetryIssue,
  requeueUnstartedIssueClaim,
  retryIssue,
  type IssueActionOptions
} from "../db/repositories/issueActions.ts";
import {
  completeRunInterrupt,
  failRunInterrupt,
  prepareRunInterrupt,
  readRunRevision,
  type PreparedProviderMutation
} from "../domain/run/service.ts";
import { getAgentSession } from "../db/repositories/agentSessions.ts";
import { issueTimestamp } from "../db/repositories/issueCreate.ts";
import { getIssue, listIssueRuns, listIssues, type Issue } from "../db/repositories/issues.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { redactSensitiveText } from "../util/redact.ts";
import type { AppEvent, EventBus } from "../events/bus.ts";
import { isExecutorProviderId, type ExecutorProvider, type ExecutorProviderId, type InterruptInput, type SessionRef } from "../providers/types.ts";

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
const ISSUE_RETRY_REASON = "issue_retry";
const SESSION_INTERRUPT_REASON = "session_interrupt";

export async function cancelIssueWithInterrupt(
  db: RunnerDatabase,
  issueID: number,
  runtime: InterruptRuntime = {}
): Promise<Issue> {
  const issue = issueWithLatestRun(db, mustGetIssue(db, issueID));
  if (shouldInterruptIssue(issue)) {
    await interruptLinkedIssue(db, issue, ISSUE_CANCEL_REASON, runtime);
  }
  return cancelIssue(db, issueID, ISSUE_CANCEL_REASON);
}

export async function retryIssueWithInterrupt(
  db: RunnerDatabase,
  issueID: number,
  options: IssueActionOptions = {},
  runtime: InterruptRuntime = {}
): Promise<Issue> {
  const issue = issueWithLatestRun(db, mustGetIssue(db, issueID));
  if (!isOpenRunningIssue(issue)) return retryIssue(db, issueID, options);
  if (!shouldInterruptIssue(issue)) {
    if (hasDeferredStartupFailure(db, issue)) return requeueUnstartedIssueClaim(db, issueID);
    throw new Error("Issue 正在启动 provider session，请稍后再重试");
  }
  const interrupted = await interruptLinkedIssue(db, issue, ISSUE_RETRY_REASON, runtime);
  if (!interrupted) throw new Error("旧 Session 中断失败，Issue 未重新排队");
  return forceRetryIssue(db, issueID, options);
}

function hasDeferredStartupFailure(db: RunnerDatabase, issue: Issue): boolean {
  const run = issue.latest_run;
  if (!run || run.provider_session_id !== "" || run.provider_turn_id !== "") return false;
  const row = db.sqlite.query<{ count: number }, [number, string]>(`
    select count(*) as count from issue_events
    where issue_id=? and type='issue.provider_deferred' and created_at>=?
  `).get(issue.id, run.started_at);
  return (row?.count ?? 0) > 0;
}

export async function interruptSession(
  db: RunnerDatabase,
  rawSessionID: string,
  runtime: InterruptRuntime = {}
): Promise<SessionInterruptResult> {
  const session = sessionRef(rawSessionID, latestTurnID(db, rawSessionID));
  const linked = linkedRunningIssue(db, session);
  if (linked) {
    return { interrupted: await interruptLinkedIssue(db, linked, SESSION_INTERRUPT_REASON, runtime) };
  }
  if (!session.turnId && session.provider === "codex") return { interrupted: false };
  const error = await interruptProviderTurn(db, 0, session, SESSION_INTERRUPT_REASON, runtime);
  return { interrupted: !error };
}

function shouldInterruptIssue(issue: Issue): boolean {
  if (!isOpenRunningIssue(issue)) return false;
  const run = issue.latest_run;
  if (!run) return false;
  return (run.provider_session_id !== "" && run.provider_turn_id !== "") ||
    (issue.codex_thread_id !== "" && issue.codex_turn_id !== "");
}

function isOpenRunningIssue(issue: Issue): boolean {
  return issue.status === "in_progress" && Boolean(issue.latest_run && issue.latest_run.ended_at === "");
}

async function interruptLinkedIssue(
  db: RunnerDatabase,
  issue: Issue,
  reason: string,
  runtime: InterruptRuntime
): Promise<boolean> {
  const session = issueSessionRef(issue);
  const lifecycle = prepareLinkedRunInterrupt(db, issue, session, reason);
  if (!lifecycle.should_invoke) return lifecycle.completed;
  recordInterruptEvent(db, issue.id, "issue.interrupt_requested", session, reason, runtime.bus);
  const error = await interruptProviderTurn(db, issue.id, session, reason, runtime);
  if (error) {
    failRunInterrupt(db, lifecycleEventID(lifecycle, reason), error);
    return false;
  }
  completeRunInterrupt(db, lifecycleEventID(lifecycle, reason));
  recordInterruptEvent(db, issue.id, "issue.interrupted", session, reason, runtime.bus);
  return true;
}

function prepareLinkedRunInterrupt(
  db: RunnerDatabase,
  issue: Issue,
  session: SessionRef,
  reason: string
): PreparedProviderMutation {
  const run = issue.latest_run;
  if (!run) throw new Error("Issue Run 不存在，无法中断");
  const attempt = db.sqlite.query<{
    attempt_id: string;
    provider: string;
    provider_invocation_ref: string;
    provider_session_id: string;
    provider_turn_id: string;
    revision: number;
  }, [string]>(`
    select attempt_id, revision, provider, provider_invocation_ref,
      provider_session_id, provider_turn_id
    from run_attempts where issue_run_id=? order by sequence desc limit 1
  `).get(run.id);
  if (!attempt) throw new Error("Run Attempt 不存在，无法中断");
  const runID = `xw:run:issue_runs:${run.id}` as const;
  const eventID = interruptLifecycleEventID(attempt.attempt_id, reason);
  return prepareRunInterrupt(db, {
    attempt_id: attempt.attempt_id,
    audit: {
      actor: { id: "runner-interrupt", kind: "runner" },
      correlation_id: `issue:${issue.id}:${eventID}`,
      event_id: eventID,
      gate: {
        authority: "deterministic_policy",
        decision: "allow",
        policy_ref: "run-lifecycle:p03.04:interrupt"
      },
      occurred_at: issueTimestamp(),
      reason
    },
    expected_attempt_revision: attempt.revision,
    expected_revision: readRunRevision(db, runID),
    issue_run_id: run.id,
    provider_ref: {
      invocation_ref: attempt.provider_invocation_ref || run.id,
      provider: attempt.provider || session.provider,
      session_ref: attempt.provider_session_id || session.sessionId,
      turn_ref: attempt.provider_turn_id || session.turnId
    },
    run_id: runID
  });
}

function lifecycleEventID(prepared: PreparedProviderMutation, reason: string): string {
  return interruptLifecycleEventID(prepared.attempt_id, reason);
}

function interruptLifecycleEventID(attemptID: string, reason: string): string {
  return `run-interrupt:${attemptID}:${reason}`;
}

function issueSessionRef(issue: Issue): SessionRef {
  const run = issue.latest_run;
  if (run?.provider_session_id) {
    const turnId = run.provider_turn_id || issue.codex_turn_id;
    return {
      provider: providerID(run.provider),
      sessionId: run.provider_session_id,
      ...(turnId === "" ? {} : { turnId })
    };
  }
  return sessionRef(issue.codex_thread_id, issue.codex_turn_id);
}

async function interruptProviderTurn(
  db: RunnerDatabase,
  issueID: number,
  session: SessionRef,
  reason: string,
  runtime: InterruptRuntime
): Promise<Error | null> {
  const provider = runtime.providers?.[session.provider];
  if (!provider?.interrupt) {
    const error = new Error(`provider "${session.provider}" interrupt unavailable`);
    if (issueID > 0) recordInterruptFailed(db, issueID, session, reason, error.message, runtime.bus);
    return error;
  }
  const error = await interruptWithTimeout(provider, { session, reason }, runtime.interruptTimeoutMs);
  if (error && issueID > 0) {
    recordInterruptFailed(db, issueID, session, reason, safeError(error), runtime.bus);
  }
  return error;
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

function linkedRunningIssue(db: RunnerDatabase, session: SessionRef): Issue | null {
  for (const issue of listIssues(db, { status: "in_progress" })) {
    const hydrated = issueWithLatestRun(db, issue);
    const run = hydrated.latest_run;
    if (run?.ended_at === "" && run.provider === session.provider && run.provider_session_id === session.sessionId) return hydrated;
    if (session.provider === "codex" && issue.codex_thread_id === session.sessionId && issue.codex_turn_id !== "") return hydrated;
  }
  return null;
}

function issueWithLatestRun(db: RunnerDatabase, issue: Issue): Issue {
  if (issue.latest_run) return issue;
  const latest_run = listIssueRuns(db, issue.id).at(-1);
  return latest_run ? { ...issue, latest_run } : issue;
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
  const provider = key.slice(0, separator);
  if (!isExecutorProviderId(provider)) throw new Error(`provider "${provider}" interrupt unavailable`);
  return { provider, sessionId: key.slice(separator + 1), ...(turnID === "" ? {} : { turnId: turnID }) };
}

function providerID(value: string): ExecutorProviderId {
  return value === "claude" || value === "fake-execution-only" ? value : "codex";
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
