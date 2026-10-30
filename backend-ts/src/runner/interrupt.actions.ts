import { cancelIssue, forceRetryIssue, requeueUnstartedIssueClaim, retryIssue, type IssueActionOptions } from "../db/repositories/issueActions.ts";
import { completeRunInterrupt, failRunInterrupt } from "../domain/run/service.ts";
import { getAgentSession } from "../db/repositories/agentSessions.ts";
import { type Issue } from "../db/repositories/issues.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { providersForProjectID } from "../nodes/remoteExecution.ts";
import { type ExecutorProviderId, type SessionRef } from "../providers/types.ts";
import { ISSUE_CANCEL_REASON, ISSUE_RETRY_REASON, SESSION_INTERRUPT_REASON } from "./interrupt.model.ts";
import type { InterruptRuntime, SessionInterruptResult } from "./interrupt.model.ts";
import { issueWithLatestRun, linkedSessionIsTerminal, reconcileTerminalSessionForRetry, sessionRef, latestTurnID, linkedRunningIssue, interruptProviderTurn, issueSessionRef } from "./interrupt.sessions.ts";
import { mustGetIssue, prepareLinkedRunInterrupt, recordInterruptEvent } from "./interrupt.events.ts";

export async function cancelIssueWithInterrupt(
  db: RunnerDatabase,
  issueID: number,
  projectRuntime: InterruptRuntime = {}
): Promise<Issue> {
  const issue = issueWithLatestRun(db, mustGetIssue(db, issueID));
  const runtime = issueProjectRuntime(db, issue, projectRuntime);
  if (shouldInterruptIssue(issue, runtime)) {
    await interruptLinkedIssue(db, issue, ISSUE_CANCEL_REASON, runtime);
  }
  return cancelIssue(db, issueID, ISSUE_CANCEL_REASON);
}

export async function interruptIssueForStatusTransition(
  db: RunnerDatabase,
  issueID: number,
  reason: string,
  projectRuntime: InterruptRuntime = {}
): Promise<Issue> {
  const issue = issueWithLatestRun(db, mustGetIssue(db, issueID));
  const runtime = issueProjectRuntime(db, issue, projectRuntime);
  if (!shouldInterruptIssue(issue, runtime)) return issue;
  const interrupted = await interruptLinkedIssue(db, issue, reason, runtime);
  if (!interrupted) throw new Error("旧 Session 中断失败，Issue 状态未更新");
  return issue;
}

export async function retryIssueWithInterrupt(
  db: RunnerDatabase,
  issueID: number,
  options: IssueActionOptions = {},
  projectRuntime: InterruptRuntime = {}
): Promise<Issue> {
  const issue = issueWithLatestRun(db, mustGetIssue(db, issueID));
  const runtime = issueProjectRuntime(db, issue, projectRuntime);
  if (!isOpenRunningIssue(issue)) return retryIssue(db, issueID, options);
  if (linkedSessionIsTerminal(db, issue)) {
    reconcileTerminalSessionForRetry(db, issue, runtime);
    return forceRetryIssue(db, issueID, options);
  }
  if (!shouldInterruptIssue(issue, runtime)) {
    if (hasDeferredStartupFailure(db, issue)) return requeueUnstartedIssueClaim(db, issueID);
    throw new Error("Issue 正在启动 provider session，请稍后再重试");
  }
  const interrupted = await interruptLinkedIssue(db, issue, ISSUE_RETRY_REASON, runtime);
  if (!interrupted) throw new Error("旧 Session 中断失败，Issue 未重新排队");
  return forceRetryIssue(db, issueID, options);
}

export function hasDeferredStartupFailure(db: RunnerDatabase, issue: Issue): boolean {
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
    const interrupted = await interruptLinkedIssue(db, linked, SESSION_INTERRUPT_REASON, issueProjectRuntime(db, linked, runtime));
    return { interrupted };
  }
  // 远程项目的交互式会话在其节点上中断。
  runtime = sessionProjectRuntime(db, session, runtime);
  // P5：无 turn（messageRef）时无法定位 active invocation；仅当 Provider 声明 session-level
  // interrupt（interrupt 方法存在）才继续，否则 fail closed 跳过（避免误中断）。
  const provider = runtime.providers?.[session.provider];
  // 兼容已迁移前的 Provider：历史契约以存在 interrupt 方法表示 session-level；
  // 只有显式声明 turn scope 时才要求 turn id。Pi 声明 active，可中断独占 transport。
  if (!session.turnId && (!provider?.interrupt || provider.interruptScope === "turn")) {
    return { interrupted: false };
  }
  const error = await interruptProviderTurn(db, 0, session, SESSION_INTERRUPT_REASON, runtime);
  return { interrupted: !error };
}

/** 远程项目的运行在节点上，中断要发给该节点的 provider。 */
export function issueProjectRuntime(db: RunnerDatabase, issue: Issue, runtime: InterruptRuntime): InterruptRuntime {
  const providers = providersForProjectID(db, runtime.providers, issue.project_id);
  return providers === runtime.providers ? runtime : { ...runtime, providers };
}

export function sessionProjectRuntime(db: RunnerDatabase, session: SessionRef, runtime: InterruptRuntime): InterruptRuntime {
  const projectID = getAgentSession(db, `${session.provider}:${session.sessionId}`)?.project_id ?? "";
  const providers = providersForProjectID(db, runtime.providers, projectID);
  return providers === runtime.providers ? runtime : { ...runtime, providers };
}

export function shouldInterruptIssue(issue: Issue, runtime: InterruptRuntime): boolean {
  if (!isOpenRunningIssue(issue)) return false;
  const run = issue.latest_run;
  if (!run) return false;
  const provider = runtime.providers?.[run.provider as ExecutorProviderId];
  if (!provider?.interrupt) return false;
  if (provider.interruptScope === "active") return true;
  const sessionID = run.provider_session_id || issue.codex_thread_id;
  const turnID = run.provider_turn_id || issue.codex_turn_id;
  if (provider.interruptScope === "session") return sessionID !== "";
  return sessionID !== "" && turnID !== "";
}

export function isOpenRunningIssue(issue: Issue): boolean {
  return issue.status === "in_progress" && Boolean(issue.latest_run && issue.latest_run.ended_at === "");
}

export async function interruptLinkedIssue(
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
    failRunInterrupt(db, lifecycle.lifecycle_event_id, error);
    return false;
  }
  completeRunInterrupt(db, lifecycle.lifecycle_event_id);
  recordInterruptEvent(db, issue.id, "issue.interrupted", session, reason, runtime.bus);
  return true;
}

export function interruptLifecycleEventID(
  attemptID: string,
  reason: string,
  runRevision: number,
  attemptRevision: number
): string {
  return `run-interrupt:${attemptID}:${reason}:r${runRevision}:a${attemptRevision}`;
}
