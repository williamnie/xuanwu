import { prepareRunInterrupt, readRunRevision } from "../domain/run/service.ts";
import type { PreparedProviderMutation } from "../domain/run/lifecycleStore.ts";
import { issueTimestamp } from "../db/repositories/issueCreate.ts";
import { getIssue, type Issue } from "../db/repositories/issues.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { redactSensitiveText } from "../util/redact.ts";
import type { AppEvent, EventBus } from "../events/bus.ts";
import { type SessionRef } from "../providers/types.ts";
import { interruptLifecycleEventID } from "./interrupt.actions.ts";

export function prepareLinkedRunInterrupt(
  db: RunnerDatabase,
  issue: Issue,
  session: SessionRef,
  reason: string
): PreparedProviderMutation & { lifecycle_event_id: string } {
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
  const runRevision = readRunRevision(db, issue.id, runID);
  const eventID = interruptLifecycleEventID(attempt.attempt_id, reason, runRevision, attempt.revision);
  const prepared = prepareRunInterrupt(db, {
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
    expected_revision: runRevision,
    issue_run_id: run.id,
    provider_ref: {
      invocation_ref: attempt.provider_invocation_ref || run.id,
      provider: attempt.provider || session.provider,
      session_ref: attempt.provider_session_id || session.sessionId,
      turn_ref: attempt.provider_turn_id || session.turnId
    },
    run_id: runID
  });
  return { ...prepared, lifecycle_event_id: eventID };
}

export function recordInterruptEvent(
  db: RunnerDatabase,
  issueID: number,
  type: string,
  session: SessionRef,
  reason: string,
  bus?: Pick<EventBus, "publish">
): void {
  recordEvent(db, issueID, type, {
    thread_id: session.sessionId,
    turn_id: session.turnId ?? "",
    reason
  }, bus, session);
}

export function recordInterruptFailed(
  db: RunnerDatabase,
  issueID: number,
  session: SessionRef,
  reason: string,
  error: string,
  bus?: Pick<EventBus, "publish">
): void {
  recordEvent(db, issueID, "issue.interrupt_failed", {
    thread_id: session.sessionId,
    turn_id: session.turnId ?? "",
    reason,
    error
  }, bus, session, error);
}

export function recordEvent(
  db: RunnerDatabase,
  issueID: number,
  type: string,
  payload: Record<string, string>,
  bus: Pick<EventBus, "publish"> | undefined,
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

export function publish(bus: Pick<EventBus, "publish"> | undefined, event: AppEvent): void {
  bus?.publish(event);
}

export function lastInsertID(db: RunnerDatabase): number {
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  return row?.id ?? 0;
}

export function mustGetIssue(db: RunnerDatabase, id: number): Issue {
  const issue = getIssue(db, id);
  if (!issue) throw new Error("资源不存在");
  return issue;
}

export function safeError(error: Error): string {
  return redactSensitiveText(error.message);
}
