import { expect, test } from "bun:test";

import { openDatabase } from "../../db/database.ts";

import { projectNormalizedRunEvent } from "../../db/repositories/runAttemptEvents.ts";
import { normalizedRunEvent, providerRunCost } from "../../providers/runEvents.ts";

import { RUN_LIFECYCLE_EVENT_TYPES } from "./lifecycleStore.ts";
import {
  auditRunRevisionIssueScope,
  completeRunAttemptStart,
  completeRunInterrupt,
  prepareRunAttempt,
  prepareRunInterrupt,
  readRunRevision,
  requestNewRun
} from "./service.ts";

import {
  trackDatabase,
  NOW,
  LATER,
  openFixture,
  activeRun,
  attemptCommand,
  interruptCommand,
  newRunCommand,
  attempts,
  measuredCost,
  lifecyclePayload,
  eventCount,
  issueState,
  runState
} from "./serviceTestFixtures.ts";

export function registerServiceLifecycleCases() {
  test("prepares and starts one resume Attempt for repeated commands", async () => {
    const fixture = await openFixture("resume-idempotency");
    const run = activeRun(fixture.db, "thread-resume", "turn-1");
    const command = attemptCommand(fixture.db, run, "resume", "resume-1", "succeeded");

    const first = prepareRunAttempt(fixture.db, command);
    const duplicate = prepareRunAttempt(fixture.db, command);
    expect(first).toMatchObject({ completed: false, replayed: false, should_invoke: true });
    expect(duplicate).toMatchObject({ attempt_id: first.attempt_id, replayed: true, should_invoke: false });

    const provider = {
      invocation_ref: "codex:thread-resume:turn-2",
      provider_session_id: "thread-resume",
      provider_turn_id: "turn-2"
    };
    expect(completeRunAttemptStart(fixture.db, "resume-1", provider)).toMatchObject({ completed: true, replayed: false });
    expect(completeRunAttemptStart(fixture.db, "resume-1", provider)).toMatchObject({ completed: true, replayed: true });

    expect(attempts(fixture.db, run.issue_run_id)).toEqual([
      expect.objectContaining({ kind: "initial", sequence: 1, status: "succeeded" }),
      expect.objectContaining({
        attempt_id: first.attempt_id,
        kind: "resume",
        provider_invocation_ref: "codex:thread-resume:turn-2",
        provider_session_id: "thread-resume",
        provider_turn_id: "turn-2",
        sequence: 2,
        status: "running"
      })
    ]);
    expect(eventCount(fixture.db, "resume-1", RUN_LIFECYCLE_EVENT_TYPES.intent)).toBe(1);
    expect(eventCount(fixture.db, "resume-1", RUN_LIFECYCLE_EVENT_TYPES.outcome)).toBe(1);
    expect(readRunRevision(fixture.db, run.issue_id, run.run_id)).toBe(2);
  });

  test("scopes Run revision by Issue and uses the existing issue/type index", async () => {
    const fixture = await openFixture("revision-issue-scope");
    const run = activeRun(fixture.db, "thread-scope", "turn-scope");
    const other = activeRun(fixture.db, "thread-other", "turn-other");
    const eventType = RUN_LIFECYCLE_EVENT_TYPES.runRequested;
    fixture.db.sqlite.run(
      "insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)",
      [run.issue_id, eventType, JSON.stringify({ after_revision: 2, run_id: run.run_id }), NOW]
    );
    fixture.db.sqlite.run(
      "insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)",
      [other.issue_id, eventType, JSON.stringify({ after_revision: 999, run_id: run.run_id }), LATER]
    );

    expect(readRunRevision(fixture.db, run.issue_id, run.run_id)).toBe(2);
    expect(auditRunRevisionIssueScope(fixture.db)).toEqual([{
      event_id: expect.any(Number),
      event_issue_id: other.issue_id,
      run_id: run.run_id,
      run_issue_id: run.issue_id
    }]);
    const plan = fixture.db.sqlite.query<{ detail: string }, [number, string, string, string, string, string]>(`
        explain query plan
        select max(cast(json_extract(payload, '$.after_revision') as integer)) as revision
        from issue_events
        where issue_id=? and type in (?, ?, ?, ?) and json_valid(payload)
          and json_extract(payload, '$.run_id')=?
      `).all(
      run.issue_id,
      RUN_LIFECYCLE_EVENT_TYPES.intent,
      RUN_LIFECYCLE_EVENT_TYPES.outcome,
      RUN_LIFECYCLE_EVENT_TYPES.runMaterialized,
      RUN_LIFECYCLE_EVENT_TYPES.runRequested,
      run.run_id
    ).map((row) => row.detail);
    expect(plan.some((detail) => detail.includes("idx_issue_events_issue_type") &&
      detail.includes("issue_id=?") && detail.includes("type=?"))).toBe(true);
  });

  test("fails closed on a prepared recovery after database restart and preserves provider turn refs", async () => {
    const fixture = await openFixture("recovery-restart");
    const run = activeRun(fixture.db, "thread-recovery", "turn-old");
    const command = attemptCommand(fixture.db, run, "recovery", "recovery-1", "interrupted");
    const prepared = prepareRunAttempt(fixture.db, command);
    fixture.db.close();

    const reopened = await openDatabase({ stateDir: fixture.stateDir }).then(trackDatabase);
    expect(prepareRunAttempt(reopened, command)).toEqual({
      ...prepared,
      completed: false,
      replayed: true,
      should_invoke: false
    });
    completeRunAttemptStart(reopened, "recovery-1", {
      invocation_ref: "codex:thread-recovery:turn-recovered",
      provider_session_id: "thread-recovery",
      provider_turn_id: "turn-recovered"
    });
    expect(attempts(reopened, run.issue_run_id)).toEqual([
      expect.objectContaining({ sequence: 1, status: "interrupted" }),
      expect.objectContaining({
        kind: "recovery",
        provider_session_id: "thread-recovery",
        provider_turn_id: "turn-recovered",
        sequence: 2,
        status: "running"
      })
    ]);
  });

  test("projects Codex provider-session totals as an audited resume Attempt delta", async () => {
    const fixture = await openFixture("resume-usage-delta");
    const run = activeRun(fixture.db, "thread-usage", "turn-1");
    fixture.db.sqlite.run("update run_attempts set cost_json=?, revision=revision+1 where issue_run_id=?", [
      JSON.stringify(measuredCost(12, 5, 3, 2)),
      run.issue_run_id
    ]);
    const command = attemptCommand(fixture.db, run, "resume", "resume-usage-1", "succeeded");
    const prepared = prepareRunAttempt(fixture.db, command);
    completeRunAttemptStart(fixture.db, "resume-usage-1", {
      invocation_ref: "codex:thread-usage:turn-2",
      provider_session_id: "thread-usage",
      provider_turn_id: "turn-2"
    });
    const cost = providerRunCost({
      sourceRef: "provider-event:usage-total",
      usage: {
        cached_input_tokens: 5,
        input_tokens: 20,
        output_tokens: 8,
        reasoning_output_tokens: 3,
        total_tokens: 28
      }
    });
    if (!cost) throw new Error("fixture cost missing");
    projectNormalizedRunEvent(fixture.db, run.issue_run_id, normalizedRunEvent({
      cost,
      kind: "progress",
      metadata: { usage_scope: "provider_session_total" },
      method: "thread/tokenUsage/updated",
      outcome: "running",
      provider: "codex",
      session: { provider: "codex", sessionId: "thread-usage", turnId: "turn-2" }
    }), 900);

    const resumed = attempts(fixture.db, run.issue_run_id).find((attempt) => attempt.attempt_id === prepared.attempt_id);
    expect(JSON.parse(String(resumed?.cost_json ?? "{}"))).toMatchObject({
      usage: {
        cached_input_tokens: 2,
        completeness: "complete",
        input_tokens: 8,
        output_tokens: 3,
        reasoning_output_tokens: 1,
        total_tokens: 11
      }
    });
    const intent = lifecyclePayload(fixture.db, "resume-usage-1", RUN_LIFECYCLE_EVENT_TYPES.intent);
    expect(intent.provider_usage_baseline).toMatchObject({ attempt_id: expect.stringContaining("~attempt:1") });
  });

  test("serializes interrupt races and supersedes only an interrupted Attempt", async () => {
    const fixture = await openFixture("interrupt-race");
    const run = activeRun(fixture.db, "thread-interrupt", "turn-live");
    const firstCommand = interruptCommand(fixture.db, run, "interrupt-1");
    const prepared = prepareRunInterrupt(fixture.db, firstCommand);
    const racingCommand = { ...interruptCommand(fixture.db, run, "interrupt-2"), expected_revision: 0 };

    expect(() => prepareRunInterrupt(fixture.db, racingCommand)).toThrow("Run revision mismatch");
    expect(completeRunInterrupt(fixture.db, "interrupt-1")).toMatchObject({ completed: true, replayed: false });
    expect(completeRunInterrupt(fixture.db, "interrupt-1")).toMatchObject({ completed: true, replayed: true });
    expect(attempts(fixture.db, run.issue_run_id).at(-1)).toMatchObject({ status: "interrupted" });

    const supersede = newRunCommand(fixture.db, run, "supersede", "supersede-1");
    expect(requestNewRun(fixture.db, supersede)).toMatchObject({ applied: true, replayed: false, requested_sequence: 2 });
    expect(requestNewRun(fixture.db, supersede)).toMatchObject({ applied: true, replayed: true, requested_sequence: 2 });
    expect(issueState(fixture.db, run.issue_id)).toMatchObject({ status: "todo" });
    expect(runState(fixture.db, run.issue_run_id)).toMatchObject({ status: "cancelled" });
    expect(attempts(fixture.db, run.issue_run_id).at(-1)).toMatchObject({ status: "interrupted" });
  });
}
