import { getAgentSession } from "../db/repositories/agentSessions.ts";
import { requeueUnstartedIssueClaim } from "../db/repositories/issueActions.ts";
import { listIssueEvents, recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { listIssues, type Issue } from "../db/repositories/issues.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { isProviderId, type ExecutorProviderId, type SessionRef } from "../providers/types.ts";
import { requestIssuePiAcceptance } from "./piAcceptanceRequest.ts";
import { reconcileProviderOutcome, type ProviderReportedOutcome } from "./providerOutcome.ts";

export type RecoveryInput = {
  database: RunnerDatabase;
  now?: Date;
};

export type RecoveryResult = { reconciled: number; requeued: number; signaled: number };

/**
 * 启动恢复只修复机械事实，不替 PI 做恢复决策：
 * - Provider 尚未创建 Session 的 claim 可以安全回到 todo；
 * - 已终止的 Provider Session 只收口 Run 并请求 PI 判断；
 * - 其他断线、失联、缺 Session 情况只记录信号，交给 PI 决定是否及如何 resume。
 */
export async function recoverInProgressIssues(input: RecoveryInput): Promise<RecoveryResult> {
  const result: RecoveryResult = { reconciled: 0, requeued: 0, signaled: 0 };
  for (const issue of listIssues(input.database, { status: "in_progress" })) {
    const outcome = await reconcileIssueOnStartup(input.database, issue, input.now ?? new Date());
    result[outcome] += 1;
  }
  return result;
}

async function reconcileIssueOnStartup(
  db: RunnerDatabase,
  issue: Issue,
  now: Date
): Promise<keyof RecoveryResult> {
  const run = issue.latest_run;
  if (!run) {
    recordRecoverySignal(db, issue, null, "missing_run");
    return "signaled";
  }
  if (run.ended_at !== "") {
    requestIssuePiAcceptance(db, issue.id, {
      reason: "Runner restarted after Provider Run reached terminal state",
      source: "startup-reconciler"
    });
    return "reconciled";
  }
  if (canRequeueUnstartedClaim(db, issue)) {
    requeueUnstartedIssueClaim(db, issue.id);
    recordIssueEvent(db, issue.id, "issue.recovery_requeued.v1", {
      issue_run_id: run.id,
      reason: "Provider Session was never created; mechanical claim returned to todo"
    });
    return "requeued";
  }
  const session = linkedSession(issue);
  const stored = session ? getAgentSession(db, `${session.provider}:${session.sessionId}`) : null;
  if (session && stored && TERMINAL_SESSION_STATUSES.has(normalizeStatus(stored.status))) {
    const reported = terminalSessionOutcome(stored.status);
    await reconcileProviderOutcome({
      database: db,
      issueID: issue.id,
      issueRunID: run.id,
      now,
      providerID: session.provider,
      reportedOutcome: reported
    });
    recordIssueEvent(db, issue.id, "issue.recovery_terminal_reconciled.v1", {
      issue_run_id: run.id,
      provider: session.provider,
      provider_session_id: session.sessionId,
      provider_turn_id: session.turnId ?? "",
      session_status: stored.status
    });
    return "reconciled";
  }
  recordRecoverySignal(db, issue, session, session ? "provider_session_requires_pi" : "missing_provider_session");
  return "signaled";
}

function recordRecoverySignal(
  db: RunnerDatabase,
  issue: Issue,
  session: SessionRef | null,
  reason: string
): void {
  const runID = issue.latest_run?.id ?? "";
  const exists = listIssueEvents(db, issue.id, {
    limit: 100,
    types: ["issue.recovery_signal.v1"]
  }).some((event) => {
    try {
      const payload = JSON.parse(event.payload) as Record<string, unknown>;
      return payload.issue_run_id === runID && payload.reason === reason;
    } catch {
      return false;
    }
  });
  if (exists) return;
  recordIssueEvent(db, issue.id, "issue.recovery_signal.v1", {
    issue_run_id: runID,
    provider: session?.provider ?? issue.latest_run?.provider ?? "",
    provider_session_id: session?.sessionId ?? "",
    provider_turn_id: session?.turnId ?? "",
    reason,
    required_action: "PI must read the current Session/context and decide whether to resume"
  });
}

function linkedSession(issue: Issue): SessionRef | null {
  const run = issue.latest_run;
  const provider = providerID(run?.provider);
  const sessionId = run?.provider_session_id.trim() || issue.codex_thread_id.trim();
  const turnId = run?.provider_turn_id.trim() || issue.codex_turn_id.trim();
  if (!provider || sessionId === "") return null;
  return { provider, sessionId, ...(turnId === "" ? {} : { turnId }) };
}

function providerID(value: string | undefined): ExecutorProviderId | null {
  // P5：合法 Provider ID 校验（branded，非闭合枚举）；恢复能力仍由 capability/session 状态决定。
  if (!value) return null;
  return isProviderId(value) ? (value as ExecutorProviderId) : null;
}

function canRequeueUnstartedClaim(db: RunnerDatabase, issue: Issue): boolean {
  const run = issue.latest_run;
  if (!run || run.ended_at !== "" || run.provider_session_id !== "" || run.provider_turn_id !== "") return false;
  if (issue.codex_thread_id === "") return true;
  const closed = db.sqlite.query<{ count: number }, [number, string, string]>(`
    select count(*) as count from issue_runs
    where issue_id=? and ended_at<>'' and (provider_session_id=? or codex_thread_id=?)
  `).get(issue.id, issue.codex_thread_id, issue.codex_thread_id)?.count ?? 0;
  return closed > 0;
}

function terminalSessionOutcome(status: string): ProviderReportedOutcome {
  const normalized = normalizeStatus(status);
  return normalized === "completed" || normalized === "done"
    ? { outcome: "completed", reason: `Persisted Provider Session is ${status}` }
    : { outcome: "failed", reason: `Persisted Provider Session is ${status}` };
}

function normalizeStatus(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s-]/g, "");
}

const TERMINAL_SESSION_STATUSES = new Set([
  "aborted",
  "cancelled",
  "completed",
  "done",
  "error",
  "failed",
  "stopped"
]);
