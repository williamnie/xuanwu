import { expect, test } from "bun:test";
import { createPiGuardianEvent, listPiGuardianEvents, updatePiGuardianEvent } from "../../db/repositories/pi/guardianEvents.ts";
import { listPiActions, listPiGuardianDecisions } from "../../db/repositories/pi.ts";
import { useTestDatabase } from "../../testing/harness.ts";
import { drainGuardianDecisionOrchestrator, runGuardianDecisionOrchestratorOnce } from "./guardianDecisionOrchestrator.ts";
import { heartbeatActionEvent, mergeMeta } from "./guardianDecisionActionsTestFixtures.ts";
import { inboxChecks } from "./guardianWatchdogChecks.ts";
import { watchdogContext } from "./guardianWatchdog.ts";
import { resultSummary } from "../../runner/piAutoManageScheduler.timing.ts";

const open = useTestDatabase();
const now = new Date("2026-10-30T03:00:00Z");

test("a cycle leaves excess events pending and later cycles finish them exactly once", async () => {
  const db = await open();
  for (let i = 0; i < 63; i++) createPiGuardianEvent(db, {
    id: `signal-${i}`, source_event_id: `signal-${i}`, source: "supervisor",
    project_id: "demo", event_type: "guardian.supervisor.candidate", issue_id: 123,
    severity: "watch", created_at: now.toISOString(), normalized_payload_json: { diagnosis_code: "provider_timeout" }
  });
  let handledWhenYielded = -1;
  const yielded = new Promise<void>((resolve) => setTimeout(() => {
    handledWhenYielded = listPiGuardianEvents(db, { status: "consumed" }).length;
    resolve();
  }, 0));
  const first = await drainGuardianDecisionOrchestrator(db, { now, limit: 20, maxEvents: 45 });
  await yielded;
  expect(first.scanned).toBe(45);
  expect(first.truncated).toBe(1);
  expect(resultSummary(first)?.truncated).toBe(1);
  expect(handledWhenYielded).toBeGreaterThan(0);
  expect(handledWhenYielded).toBeLessThan(45);
  expect(listPiGuardianEvents(db, { status: "pending" })).toHaveLength(18);
  const second = await drainGuardianDecisionOrchestrator(db, { now, limit: 20, maxEvents: 45 });
  expect(second.scanned).toBe(18);
  expect(second.truncated).toBe(0);
  expect(listPiGuardianEvents(db, { status: "consumed" })).toHaveLength(63);
  expect((await drainGuardianDecisionOrchestrator(db, { now })).scanned).toBe(0);
});

test("a failed event is retained as failed while later events continue", async () => {
  const db = await open();
  for (const issueID of [999, 1000]) createPiGuardianEvent(db, {
    id: `failure-${issueID}`, source_event_id: `failure-${issueID}`, source: "supervisor",
    project_id: "demo", event_type: "guardian.supervisor.candidate", issue_id: issueID,
    normalized_payload_json: { diagnosis_code: "provider_timeout" }
  });
  db.sqlite.run(`create trigger fail_one_decision before insert on pi_guardian_decisions
    when new.issue_id=999 begin select raise(abort,'fixture decision failure'); end`);
  expect(await drainGuardianDecisionOrchestrator(db, { now, limit: 1 }))
    .toMatchObject({ scanned: 2, errors: 1, truncated: 0 });
  expect(listPiGuardianEvents(db).map((event) => [event.id, event.status]))
    .toEqual([["failure-999", "failed"], ["failure-1000", "consumed"]]);
});

test("the hard cycle cap keeps a large backlog visible and subsequent cycles resume it", async () => {
  const db = await open();
  for (let i = 0; i < 251; i++) createPiGuardianEvent(db, {
    id: `backlog-${i}`, source_event_id: `backlog-${i}`, source: "supervisor",
    project_id: "demo", event_type: "guardian.supervisor.candidate", issue_id: 123,
    severity: "watch", created_at: "2026-10-30T02:00:00Z", normalized_payload_json: { diagnosis_code: "provider_timeout" }
  });
  const first = await drainGuardianDecisionOrchestrator(db, { now, maxEvents: 100000 });
  expect(first).toMatchObject({ scanned: 250, truncated: 1 });
  expect(inboxChecks(watchdogContext(db, { now }))).toMatchObject([
    { alert_type: "guardian_inbox_stalled", evidence: { count: 1 } }
  ]);
  expect(await drainGuardianDecisionOrchestrator(db, { now, maxEvents: 1 })).toMatchObject({ scanned: 1, truncated: 0 });
});

test("replaying an event keeps merge evidence and emitted actions idempotent", async () => {
  const db = await open();
  heartbeatActionEvent(db, "replayed", 501);
  const start = new Date("2026-06-18T00:03:00Z");
  runGuardianDecisionOrchestratorOnce(db, { now: start });
  updatePiGuardianEvent(db, "replayed", { status: "pending" });
  runGuardianDecisionOrchestratorOnce(db, { now: start });
  let decision = listPiGuardianDecisions(db, { issueId: 501 })[0];
  expect(mergeMeta(decision)).toMatchObject({ event_ids: ["replayed"], event_count: 1 });
  const settled = new Date("2026-06-18T00:03:31Z");
  runGuardianDecisionOrchestratorOnce(db, { now: settled });
  expect(listPiActions(db, { issueId: 501 })).toHaveLength(1);
  updatePiGuardianEvent(db, "replayed", { status: "pending" });
  runGuardianDecisionOrchestratorOnce(db, { now: settled });
  decision = listPiGuardianDecisions(db, { issueId: 501 })[0];
  expect(mergeMeta(decision)).toMatchObject({ event_ids: ["replayed"], event_count: 1 });
  expect(listPiActions(db, { issueId: 501 })).toHaveLength(1);
});

test("invalid and oversized limits cannot turn a bounded drain into an infinite loop", async () => {
  const db = await open();
  for (const value of [NaN, Infinity, -1, 0, 0.5, 100000]) {
    expect((await drainGuardianDecisionOrchestrator(db, { now, limit: value, maxEvents: value })).scanned).toBe(0);
    expect(runGuardianDecisionOrchestratorOnce(db, { now, limit: value }).scanned).toBe(0);
  }
});
