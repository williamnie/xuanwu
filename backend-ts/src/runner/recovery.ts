import { getProject } from "../db/repositories/projects.ts";
import { getAgentSession } from "../db/repositories/agentSessions.ts";
import { listIssues } from "../db/repositories/issues.ts";
import { requeueUnstartedIssueClaim } from "../db/repositories/issueActions.ts";
import { issueTimestamp } from "../db/repositories/issueCreate.ts";
import {
  completeRunAttemptStart,
  failRunAttemptStart,
  prepareRunAttempt,
  readRunRevision,
  type PreparedProviderMutation
} from "../domain/run/service.ts";
import { failIssueExecution } from "./statusGate.ts";
import {
  deferIssueToPiAfterProviderFailure,
  isProviderInfraTransientFailure,
  recordIssueEvent
} from "./providerFailure.ts";
import { redactSensitiveText } from "../util/redact.ts";
import type { Issue } from "../db/repositories/issues.ts";
import type { Project } from "../db/repositories/projects.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { ExecutorProvider, ExecutorProviderId, ProviderRecoveryInput, SessionRef } from "../providers/types.ts";
import { recoverIssueWithProvider } from "./providerRuntime.ts";
import { reconcileProviderOutcome } from "./providerOutcome.ts";

export type RecoveryInput = {
  database: RunnerDatabase;
  now?: Date;
  providers: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};

export type RecoveryResult = { deferred: number; failed: number; recovered: number; requeued: number };

const STATUS_IN_PROGRESS = "in_progress";

export async function recoverInProgressIssues(input: RecoveryInput): Promise<RecoveryResult> {
  const result = { deferred: 0, failed: 0, recovered: 0, requeued: 0 };
  const issues = listIssues(input.database, { status: STATUS_IN_PROGRESS });
  const now = input.now ?? new Date();
  for (const issue of issues) {
    const status = await recoverIssue(input, issue, now);
    result[status] += 1;
  }
  return result;
}

async function recoverIssue(input: RecoveryInput, issue: Issue, now: Date): Promise<keyof RecoveryResult> {
  if (providerRetryWindowPending(issue, now)) return "deferred";
  const session = recoverableSession(input.database, issue);
  if (!session) {
    if (canRequeueUnstartedClaim(input.database, issue)) {
      requeueUnstartedClaim(input.database, issue);
      return "requeued";
    }
    if (hasProviderDeferredFailure(input.database, issue)) {
      recordExistingProviderDeferred(input.database, issue);
      return "deferred";
    }
    markRecoveryFailed(input.database, issue.id, "missing provider_session_id; issue marked failed after restart");
    return "failed";
  }
  if (linkedSessionIsTerminal(input.database, session)) {
    await reconcileProviderOutcome({
      database: input.database,
      issueID: issue.id,
      issueRunID: issue.latest_run?.id ?? "",
      now,
      providerID: session.provider
    });
    recordRecoveryEvent(input.database, issue.id, "issue.recovery_terminal_reconciled", recoveryPayload(session));
    return "recovered";
  }
  const provider = input.providers[session.provider];
  if (!provider?.recover) {
    markRecoveryFailed(input.database, issue.id, `provider ${session.provider} does not support recovery`);
    return "failed";
  }
  const project = getProject(input.database, issue.project_id);
  if (!project) {
    markRecoveryFailed(input.database, issue.id, `project ${issue.project_id} not found`);
    return "failed";
  }
  const lifecycle = prepareRecoveryAttempt(input.database, issue, session);
  if (!lifecycle.should_invoke) {
    recordIssueEvent(input.database, issue.id, "issue.recovery_deferred", {
      reason: lifecycle.completed ? "recovery_already_started" : "recovery_intent_pending",
      run_lifecycle_attempt_id: lifecycle.attempt_id
    });
    return "deferred";
  }
  recordRecoveryEvent(input.database, issue.id, "issue.recovery_started", recoveryPayload(session));
  try {
    const run = await recoverIssueWithProvider(provider, {
      ...recoveryInput(project, issue, session),
      database: input.database
    });
    completeRunAttemptStart(input.database, recoveryEventID(lifecycle), {
      invocation_ref: run.runId,
      provider_session_id: run.session?.sessionId || session.sessionId,
      provider_turn_id: run.session?.turnId || session.turnId || run.runId
    });
    recordRecoveryEvent(input.database, issue.id, "issue.recovery_turn_started", recoveryPayload(run.session ?? session));
    return "recovered";
  } catch (error) {
    failRunAttemptStart(input.database, recoveryEventID(lifecycle), error);
    if (isProviderInfraTransientFailure(error)) {
      markRecoveryDeferred(input.database, issue.id, error, session.provider);
      return "deferred";
    }
    markRecoveryFailed(input.database, issue.id, error);
    return "failed";
  }
}

function providerRetryWindowPending(issue: Issue, now: Date): boolean {
  if (!issue.auto_retry_reason.startsWith("provider_infra_transient:")) return false;
  const retryAt = Date.parse(issue.auto_retry_next_at);
  return Number.isFinite(retryAt) && retryAt > now.getTime();
}

function prepareRecoveryAttempt(
  db: RunnerDatabase,
  issue: Issue,
  session: SessionRef
): PreparedProviderMutation {
  const run = issue.latest_run;
  if (!run) throw new Error("Issue Run 不存在，无法恢复");
  const attempts = db.sqlite.query<{
    attempt_id: string;
    kind: string;
    provider_session_id: string;
    revision: number;
    sequence: number;
    status: string | null;
  }, [string]>(`
    select attempt_id, sequence, kind, status, revision, provider_session_id
    from run_attempts where issue_run_id=? order by sequence desc limit 2
  `).all(run.id);
  const latest = attempts[0];
  if (!latest) throw new Error("Run Attempt 不存在，无法恢复");
  if (latest.kind === "recovery" && latest.status === "created") {
    return pendingRecoveryMutation(db, run.id, latest.attempt_id);
  }
  const runID = `xw:run:issue_runs:${run.id}` as const;
  const eventID = `run-recovery:${run.id}:attempt:${latest.sequence + 1}`;
  return prepareRunAttempt(db, {
    audit: {
      actor: { id: "runner-recovery", kind: "runner" },
      correlation_id: `issue:${issue.id}:${eventID}`,
      event_id: eventID,
      gate: {
        authority: "deterministic_policy",
        decision: "allow",
        policy_ref: "run-lifecycle:p03.04:restart-recovery"
      },
      occurred_at: issueTimestamp(),
      reason: "resume provider session after runner restart"
    },
    expected_attempt_revision: latest.revision,
    expected_revision: readRunRevision(db, runID),
    issue_run_id: run.id,
    kind: "recovery",
    previous_attempt_terminal: {
      reason: "runner restarted before deterministic closeout",
      source_ref: `run-lifecycle:${eventID}:restart`,
      status: latest.status === "failed" ? "failed" : "interrupted"
    },
    provider_ref: { provider: session.provider, session_ref: session.sessionId },
    run_id: runID
  });
}

function pendingRecoveryMutation(
  db: RunnerDatabase,
  issueRunID: string,
  attemptID: string
): PreparedProviderMutation {
  const row = db.sqlite.query<{ event_id: string; issue_id: number; outcome_count: number }, [string, string, string]>(`
    select json_extract(intent.payload, '$.event_id') as event_id,
      intent.issue_id,
      (select count(*) from issue_events outcome
        where outcome.type=? and json_valid(outcome.payload)
          and json_extract(outcome.payload, '$.event_id')=json_extract(intent.payload, '$.event_id')) as outcome_count
    from issue_events intent
    where intent.type=? and json_valid(intent.payload)
      and json_extract(intent.payload, '$.attempt_id')=?
    order by intent.id desc limit 1
  `).get(RUN_OUTCOME_EVENT, RUN_INTENT_EVENT, attemptID);
  if (!row?.event_id) throw new Error(`Recovery Attempt ${attemptID} 缺少审计 intent`);
  return {
    attempt_id: attemptID,
    completed: row.outcome_count > 0,
    issue_id: row.issue_id,
    issue_run_id: issueRunID,
    replayed: true,
    should_invoke: false
  };
}

function recoveryEventID(prepared: PreparedProviderMutation): string {
  const sequence = prepared.attempt_id.split("~attempt:").at(-1) ?? "";
  return `run-recovery:${prepared.issue_run_id}:attempt:${sequence}`;
}

const RUN_INTENT_EVENT = "run.lifecycle.intent.v1";
const RUN_OUTCOME_EVENT = "run.lifecycle.outcome.v1";

function recoveryInput(project: Project, issue: Issue, session: SessionRef): ProviderRecoveryInput {
  const serviceTier = recoveryServiceTier(project, issue);
  return {
    issueId: issue.id,
    projectId: project.id,
    cwd: project.cwd,
    prompt: recoveryPrompt(project, issue),
    model: project.model,
    approvalPolicy: project.approval_policy,
    serviceTier: serviceTier.value,
    serviceTierSource: serviceTier.source,
    sandbox: project.sandbox,
    session
  };
}

function recoveryServiceTier(project: Project, issue: Issue): { source: string; value: string } {
  const issueTier = cleanString(issue.service_tier);
  if (issueTier !== "") return { source: "issue", value: issueTier };
  const projectTier = cleanString(project.default_service_tier);
  if (projectTier !== "") return { source: "project", value: projectTier };
  return { source: "standard", value: "" };
}

function recoverableSession(db: RunnerDatabase, issue: Issue): SessionRef | null {
  const run = issue.latest_run;
  const provider = run?.provider === "codex" || run?.provider === "claude" || run?.provider === "fake-execution-only"
    ? run.provider
    : "codex";
  const runSessionId = run?.provider_session_id ?? "";
  const compatibilitySessionId = issue.codex_thread_id;
  const sessionId = runSessionId || (
    compatibilitySessionBelongsToClosedRun(db, issue.id, compatibilitySessionId) ? "" : compatibilitySessionId
  );
  const turnId = runSessionId ? (run?.provider_turn_id ?? "") : issue.codex_turn_id;
  if (sessionId === "") return null;
  return { provider, sessionId, ...(turnId === "" ? {} : { turnId }) };
}

function linkedSessionIsTerminal(db: RunnerDatabase, session: SessionRef): boolean {
  const stored = getAgentSession(db, `${session.provider}:${session.sessionId}`);
  return stored ? TERMINAL_SESSION_STATUSES.has(normalizeStatus(stored.status)) : false;
}

function canRequeueUnstartedClaim(db: RunnerDatabase, issue: Issue): boolean {
  const run = issue.latest_run;
  return issue.status === STATUS_IN_PROGRESS && run?.ended_at === "" &&
    run.provider_session_id === "" && run.provider_turn_id === "" &&
    (issue.codex_thread_id === "" || compatibilitySessionBelongsToClosedRun(db, issue.id, issue.codex_thread_id));
}

function compatibilitySessionBelongsToClosedRun(
  db: RunnerDatabase,
  issueID: number,
  sessionID: string
): boolean {
  if (sessionID === "") return false;
  const row = db.sqlite.query<{ count: number }, [number, string, string]>(
    `select count(*) as count from issue_runs
     where issue_id=? and ended_at<>'' and (provider_session_id=? or codex_thread_id=?)`
  ).get(issueID, sessionID, sessionID);
  return (row?.count ?? 0) > 0;
}

function hasProviderDeferredFailure(db: RunnerDatabase, issue: Issue): boolean {
  if (isProviderInfraTransientFailure(issue.error)) return true;
  const row = db.sqlite.query<{ count: number }, [number]>(
    "select count(*) as count from issue_events where issue_id=? and type='issue.provider_deferred'"
  ).get(issue.id);
  return (row?.count ?? 0) > 0;
}

function recordExistingProviderDeferred(db: RunnerDatabase, issue: Issue): void {
  recordIssueEvent(db, issue.id, "issue.recovery_deferred", {
    error: redactSensitiveText(issue.error || "provider infrastructure transient failure already deferred"),
    provider: recoveryProvider(issue),
    reason: "provider_infra_transient"
  });
}

function recoveryProvider(issue: Issue): ExecutorProviderId {
  const provider = issue.latest_run?.provider;
  return provider === "codex" || provider === "claude" || provider === "fake-execution-only" ? provider : "codex";
}

function requeueUnstartedClaim(db: RunnerDatabase, issue: Issue): void {
  requeueUnstartedIssueClaim(db, issue.id);
  recordRecoveryEvent(db, issue.id, "issue.recovery_requeued", {
    reason: "missing provider_session_id after restart; requeued unstarted claim"
  });
}

function markRecoveryFailed(db: RunnerDatabase, issueID: number, error: unknown): void {
  failIssueExecution(db, issueID, error);
  recordRecoveryEvent(db, issueID, "issue.recovery_failed", {
    error: redactSensitiveText(error instanceof Error ? error.message : String(error))
  });
}

function markRecoveryDeferred(
  db: RunnerDatabase,
  issueID: number,
  error: unknown,
  provider: ExecutorProviderId
): void {
  deferIssueToPiAfterProviderFailure(db, issueID, error, provider);
  recordIssueEvent(db, issueID, "issue.recovery_deferred", {
    error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
    provider,
    reason: "provider_infra_transient"
  });
}

function recordRecoveryEvent(db: RunnerDatabase, issueID: number, type: string, payload: Record<string, string>): void {
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, type, JSON.stringify(payload), issueTimestamp()]
  );
}

function recoveryPayload(session: SessionRef): Record<string, string> {
  return { provider: session.provider, session_id: session.sessionId, turn_id: session.turnId ?? "" };
}

function recoveryPrompt(project: Project, issue: Issue): string {
  return `服务重启后继续处理 issue #${issue.id}。\n\n项目路径：${project.cwd}\n\n在继续前必须先检查当前工作区、issue 状态和最近日志，避免重复已完成操作。Runner Host 负责最终状态写回；不要为了回写状态调用 localhost 或 shell CLI。最终回复必须以 RUNNER_OUTCOME: completed、RUNNER_OUTCOME: failed | <reason> 或 RUNNER_OUTCOME: needs_user | <reason> 结尾。`;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
