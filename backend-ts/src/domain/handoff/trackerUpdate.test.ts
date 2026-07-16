import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { listExternalLinksByExternal } from "../../db/repositories/externalLinks.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import {
  getPiAction,
  listPiActionEvents,
  listPiGuardianAlerts,
  updatePiAction
} from "../../db/repositories/pi.ts";
import { getTrackerUpdateOutbox } from "../../db/repositories/trackerUpdateOutbox.ts";
import { createFakeTrackerAdapter } from "../../integrations/tracker/fakeAdapter.ts";
import {
  buildTrackerUpdateCommand,
  TRACKER_UPDATE_ACTION,
  TrackerAdapterError,
  trackerTargetRef,
  trackerUpdateAuthorizationPayload,
  type TrackerStatusMapping,
  type TrackerTarget
} from "../../integrations/tracker/contracts.ts";
import { createPendingPiAction } from "../../pi/actionEngine.ts";
import type { EvidenceID, RunID, WorkID } from "../../xuanwu/coreDomainContracts.ts";
import type { HandoffRecord } from "./contracts.ts";
import { createTrackerUpdateHandoffService, type QueueTrackerUpdateInput } from "./trackerUpdate.ts";

const STATUS_MAPPING: TrackerStatusMapping = {
  delivered: "done",
  draft: "in_progress",
  ready: "pending_verification",
  superseded: null
};
const TARGET: TrackerTarget = { external_id: "TRACK-677", external_type: "issue", provider_id: "fake" };
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("tracker update Handoff", () => {
  test("runs fake tracker E2E and replays duplicate dispatch without a second external write", async () => {
    const fixture = await createFixture("e2e");
    const adapter = createFakeTrackerAdapter();
    const service = createTrackerUpdateHandoffService({ adapters: [adapter], database: fixture.db });
    try {
      const first = service.enqueue(fixture.input);
      const duplicate = service.enqueue(fixture.input);
      expect(duplicate.id).toBe(first.id);
      expect(first.command.comment).toContain("Branch: `xw/tracker-handoff`");
      expect(first.command.comment).toContain("bun test trackerUpdate.test.ts");
      expect(first.command.external_status).toBe("pending_verification");
      expect(fixture.db.sqlite.query("select count(*) as count from sync_outbox where operation_kind='tracker_update'").get())
        .toEqual({ count: 1 });

      expect(await service.dispatch()).toEqual({ attention: 0, processed: 1, retry: 0, sent: 1, skipped: 0 });
      const sent = getTrackerUpdateOutbox(fixture.db, first.id);
      expect(sent).toMatchObject({ attempt_count: 1, status: "sent" });
      expect(adapter.writes).toHaveLength(1);
      expect(listExternalLinksByExternal(fixture.db, { externalID: TARGET.external_id, source: "fake" }))
        .toHaveLength(1);

      // Fault injection: simulate a lost local commit after the provider accepted the write.
      fixture.db.sqlite.run(`update sync_outbox set status='retry', cooldown_until='',
        result_json='{}', sent_at='' where id=?`, [first.id]);
      expect(await service.dispatch()).toEqual({ attention: 0, processed: 1, retry: 0, sent: 1, skipped: 0 });
      const replayed = getTrackerUpdateOutbox(fixture.db, first.id);
      expect(replayed?.receipt?.replayed).toBe(true);
      expect(adapter.attempts).toHaveLength(2);
      expect(adapter.writes).toHaveLength(1);
      expect(listExternalLinksByExternal(fixture.db, { externalID: TARGET.external_id, source: "fake" }))
        .toHaveLength(1);
      expect((await service.dispatch()).processed).toBe(0);

      expect(listPiActionEvents(fixture.db, { actionId: fixture.actionID }).map((event) => event.event_type))
        .toEqual(expect.arrayContaining([
          "gate_decision",
          "handoff.tracker_update.queued.v1",
          "handoff.tracker_update.attempt.v1",
          "handoff.tracker_update.outcome.v1"
        ]));
    } finally {
      fixture.db.close();
    }
  });

  test("retries a transient adapter failure and later succeeds", async () => {
    const fixture = await createFixture("retry", { maxAttempts: 2 });
    const adapter = createFakeTrackerAdapter({
      failures: [new TrackerAdapterError("temporary outage", { retry_after_seconds: 5, retryable: true })]
    });
    let current = new Date("2026-07-17T08:00:00.000Z");
    const service = createTrackerUpdateHandoffService({ adapters: [adapter], database: fixture.db, now: () => current });
    try {
      const queued = service.enqueue(fixture.input);
      expect(await service.dispatch()).toEqual({ attention: 0, processed: 1, retry: 1, sent: 0, skipped: 0 });
      expect(getTrackerUpdateOutbox(fixture.db, queued.id)).toMatchObject({
        attempt_count: 1,
        retry_after_seconds: 5,
        status: "retry"
      });
      expect(listPiGuardianAlerts(fixture.db, { projectId: fixture.input.project_id })).toHaveLength(0);

      current = new Date("2026-07-17T08:00:05.000Z");
      expect(await service.dispatch()).toEqual({ attention: 0, processed: 1, retry: 0, sent: 1, skipped: 0 });
      expect(getTrackerUpdateOutbox(fixture.db, queued.id)).toMatchObject({ attempt_count: 2, status: "sent" });
      expect(adapter.attempts).toHaveLength(2);
      expect(adapter.writes).toHaveLength(1);
    } finally {
      fixture.db.close();
    }
  });

  test("moves a permanent failure into existing Guardian Attention", async () => {
    const fixture = await createFixture("attention");
    const adapter = createFakeTrackerAdapter({
      failures: [new TrackerAdapterError("permission denied token=secret-value", { retryable: false })]
    });
    const service = createTrackerUpdateHandoffService({ adapters: [adapter], database: fixture.db });
    try {
      const queued = service.enqueue(fixture.input);
      expect(await service.dispatch()).toEqual({ attention: 1, processed: 1, retry: 0, sent: 0, skipped: 0 });
      const failed = getTrackerUpdateOutbox(fixture.db, queued.id);
      expect(failed).toMatchObject({ attempt_count: 1, status: "failed" });
      expect(failed?.attention_ref).toStartWith("pi_guardian_alerts:");
      expect(failed?.last_error).not.toContain("secret-value");
      const alerts = listPiGuardianAlerts(fixture.db, { projectId: fixture.input.project_id, status: "open" });
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        alert_type: "handoff_tracker_update_failed",
        issue_id: fixture.input.issue_id,
        severity: "urgent"
      });
      expect(getPiAction(fixture.db, fixture.actionID)?.status).toBe("failed");
      expect((await service.dispatch()).processed).toBe(0);
    } finally {
      fixture.db.close();
    }
  });

  test("fails closed when the stored PI gate no longer allows the write", async () => {
    const fixture = await createFixture("denied");
    const service = createTrackerUpdateHandoffService({
      adapters: [createFakeTrackerAdapter()],
      database: fixture.db
    });
    try {
      updatePiAction(fixture.db, fixture.actionID, { gate_decision: "ask", status: "pending" });
      expect(() => service.enqueue(fixture.input)).toThrow("tracker update authorization is not allowed");
      expect(fixture.db.sqlite.query("select count(*) as count from sync_outbox where operation_kind='tracker_update'").get())
        .toEqual({ count: 0 });
    } finally {
      fixture.db.close();
    }
  });
});

async function createFixture(
  suffix: string,
  options: { maxAttempts?: number } = {}
): Promise<{ actionID: string; db: RunnerDatabase; input: QueueTrackerUpdateInput }> {
  const root = await mkdtemp(join(tmpdir(), `codex-runner-tracker-${suffix}-`));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run("insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)", [
    `demo-${suffix}`, `Demo ${suffix}`, root, "2026-07-17T07:00:00.000Z", "2026-07-17T07:00:00.000Z"
  ]);
  const issue = createIssue(db, {
    description: "Tracker Handoff fixture",
    project_id: `demo-${suffix}`,
    title: `Tracker ${suffix}`
  });
  const idempotencyKey = `tracker-update-${suffix}`;
  const provisional = handoff(issue.id, suffix, "pi_action_events:pending");
  const command = buildTrackerUpdateCommand({
    correlation_id: `tracker-update:${idempotencyKey}`,
    handoff: provisional,
    idempotency_key: idempotencyKey,
    project_id: issue.project_id,
    status_mapping: STATUS_MAPPING,
    target: TARGET,
    verification: verification()
  });
  const gated = createPendingPiAction(db, { source: "test" }, {
    actionType: TRACKER_UPDATE_ACTION,
    authorization: {
      allowed_actions: [TRACKER_UPDATE_ACTION],
      mode: "delegated",
      scope: { issue_id: issue.id, project_id: issue.project_id }
    },
    issueID: issue.id,
    payload: trackerUpdateAuthorizationPayload(command),
    projectID: issue.project_id,
    rationale: "Focused fake tracker fixture",
    riskOverride: { requiresConfirmation: false, riskLevel: "low" }
  });
  const action = getPiAction(db, gated.action_id);
  if (!action) throw new Error("fixture gate action missing");
  const gateEvent = listPiActionEvents(db, { actionId: action.id })
    .filter((event) => event.event_type === "gate_decision" && event.decision === "execute").at(-1);
  if (!gateEvent) throw new Error("fixture gate event missing");
  const finalHandoff = handoff(issue.id, suffix, `pi_action_events:${gateEvent.id}`);
  return {
    actionID: action.id,
    db,
    input: {
      authorization_action_id: action.id,
      handoff: finalHandoff,
      handoff_context: handoffContext(finalHandoff),
      idempotency_key: idempotencyKey,
      issue_id: issue.id,
      max_attempts: options.maxAttempts,
      project_id: issue.project_id,
      status_mapping: STATUS_MAPPING,
      target: TARGET,
      verification: verification()
    }
  };
}

function handoff(issueID: number, suffix: string, trackerAuditRef: string): HandoffRecord {
  const workID = `xw:work:issues:${issueID}` as WorkID;
  return {
    schema_version: 1,
    id: `xw:handoff:derived:tracker-${suffix}`,
    work_id: workID,
    run_ids: [`xw:run:issue_runs:tracker-${suffix}` as RunID],
    evidence_ids: [`xw:evidence:issue_events:tracker-${suffix}` as EvidenceID],
    revision: 0,
    status: "ready",
    summary: `Deliver tracker Handoff ${suffix}`,
    created_at: "2026-07-17T07:30:00.000Z",
    updated_at: "2026-07-17T07:30:00.000Z",
    baseline_revision: "a".repeat(40),
    final_revision: "b".repeat(40),
    review_ref: "review:not-requested",
    changed_files: ["backend-ts/src/domain/handoff/trackerUpdate.ts"],
    delivery: {
      mode: "branch_commit",
      branch_ref: "xw/tracker-handoff",
      commit_ref: "b".repeat(40)
    },
    delivery_actions: [
      {
        action: "commit",
        required: true,
        classification: "state_change",
        target: "refs/heads/xw/tracker-handoff",
        gate: { authority: "deterministic_policy", policy_ref: "policy:test" },
        gate_decision: "allow",
        outcome: "succeeded",
        audit_event_ref: "pi_action_events:commit",
        after_ref: "b".repeat(40)
      },
      {
        action: "tracker_update",
        required: true,
        classification: "external_write",
        target: trackerTargetRef(TARGET),
        gate: { authority: "deterministic_policy", policy_ref: "policy:test" },
        gate_decision: "allow",
        outcome: "not_executed",
        audit_event_ref: trackerAuditRef
      }
    ],
    risks: [],
    rollback: {
      availability: "available",
      destructive: false,
      plan: "Keep the tracker receipt and supersede the Handoff comment.",
      refs: ["refs/heads/xw/tracker-handoff"]
    },
    review: {
      required: false,
      state: "not_applicable",
      reviewer_refs: []
    }
  };
}

function handoffContext(value: HandoffRecord) {
  return {
    evidence: value.evidence_ids.map((id) => ({ id, status: "passed" as const, work_id: value.work_id })),
    runs: value.run_ids.map((id) => ({ id, work_id: value.work_id }))
  };
}

function verification() {
  return [{ command: "bun test trackerUpdate.test.ts", outcome: "passed" as const, summary: "fake E2E" }];
}
