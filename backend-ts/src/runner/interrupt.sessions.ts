import { completeRunInterrupt } from "../domain/run/service.ts";
import { getAgentSession } from "../db/repositories/agentSessions.ts";
import { listIssueRuns, listIssues, type Issue } from "../db/repositories/issues.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { asProviderId, type ExecutorProvider, type ExecutorProviderId, type InterruptInput, type SessionRef } from "../providers/types.ts";
import { ISSUE_RETRY_REASON, DEFAULT_INTERRUPT_TIMEOUT_MS } from "./interrupt.model.ts";
import type { InterruptRuntime } from "./interrupt.model.ts";
import { prepareLinkedRunInterrupt, recordInterruptEvent, recordInterruptFailed, safeError } from "./interrupt.events.ts";

export function issueSessionRef(issue: Issue): SessionRef {
  const run = issue.latest_run;
  if (run?.provider_session_id) {
    const turnId = run.provider_turn_id || issue.codex_turn_id;
    return {
      // P5：合法 ID 直接使用（不再回退到 codex 的手写穷举）；非法 ID fail closed。
      provider: asProviderId(run.provider) as ExecutorProviderId,
      sessionId: run.provider_session_id,
      ...(turnId === "" ? {} : { turnId })
    };
  }
  if (issue.codex_thread_id !== "") return sessionRef(issue.codex_thread_id, issue.codex_turn_id);
  if (run?.provider) {
    return {
      provider: asProviderId(run.provider) as ExecutorProviderId,
      sessionId: ""
    };
  }
  return sessionRef("", "");
}

export function linkedSessionIsTerminal(db: RunnerDatabase, issue: Issue): boolean {
  const session = issueSessionRef(issue);
  if (session.sessionId === "") return false;
  const stored = getAgentSession(db, `${session.provider}:${session.sessionId}`);
  return stored ? TERMINAL_SESSION_STATUSES.has(normalizeStatus(stored.status)) : false;
}

export function reconcileTerminalSessionForRetry(
  db: RunnerDatabase,
  issue: Issue,
  runtime: InterruptRuntime
): void {
  const session = issueSessionRef(issue);
  const lifecycle = prepareLinkedRunInterrupt(db, issue, session, ISSUE_RETRY_REASON);
  if (!lifecycle.completed) completeRunInterrupt(db, lifecycle.lifecycle_event_id);
  recordInterruptEvent(
    db,
    issue.id,
    "issue.interrupt_skipped_terminal",
    session,
    ISSUE_RETRY_REASON,
    runtime.bus
  );
}

export const TERMINAL_SESSION_STATUSES = new Set([
  "aborted",
  "cancelled",
  "completed",
  "done",
  "error",
  "failed",
  "stopped"
]);

export function normalizeStatus(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s-]/g, "");
}

export async function interruptProviderTurn(
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

export async function interruptWithTimeout(
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

export function linkedRunningIssue(db: RunnerDatabase, session: SessionRef): Issue | null {
  for (const issue of listIssues(db, { status: "in_progress" })) {
    const hydrated = issueWithLatestRun(db, issue);
    const run = hydrated.latest_run;
    if (run?.ended_at === "" && run.provider === session.provider && run.provider_session_id === session.sessionId) return hydrated;
    if (session.provider === "codex" && issue.codex_thread_id === session.sessionId && issue.codex_turn_id !== "") return hydrated;
  }
  return null;
}

export function issueWithLatestRun(db: RunnerDatabase, issue: Issue): Issue {
  if (issue.latest_run) return issue;
  const latest_run = listIssueRuns(db, issue.id).at(-1);
  return latest_run ? { ...issue, latest_run } : issue;
}

export function latestTurnID(db: RunnerDatabase, rawSessionID: string): string {
  const key = normalizeSessionKey(rawSessionID);
  const session = getAgentSession(db, key);
  return rawRefTurnID(session?.raw_ref);
}

export function rawRefTurnID(rawRef: string | undefined): string {
  if (!rawRef) return "";
  try {
    const parsed = JSON.parse(rawRef) as Record<string, unknown>;
    return typeof parsed.provider_turn_id === "string" ? parsed.provider_turn_id.trim() : "";
  } catch {
    return "";
  }
}

export function normalizeSessionKey(rawSessionID: string): string {
  const clean = rawSessionID.trim();
  return clean.includes(":") ? clean : `codex:${clean}`;
}

export function sessionRef(rawSessionID: string, turnID: string): SessionRef {
  const key = normalizeSessionKey(rawSessionID);
  const separator = key.indexOf(":");
  // P5：合法 Provider ID 直接通过（含未来新注册 adapter），不再白名单穷举；非法 ID fail closed。
  const provider = asProviderId(key.slice(0, separator)) as ExecutorProviderId;
  return { provider, sessionId: key.slice(separator + 1), ...(turnID === "" ? {} : { turnId: turnID }) };
}
