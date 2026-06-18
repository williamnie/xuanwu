import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import {
  createPiAction,
  createPiGuardianEvent,
  listPiActions,
  listPiGuardianDecisions,
  type PiGuardianDecision
} from "../db/repositories/pi.ts";
import { runGuardianDecisionOrchestratorOnce } from "./guardianDecisionOrchestrator.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI Guardian decision action outlet", () => {
  test("creates one gated PI action for duplicate heartbeat action candidates", async () => {
    const db = await openFixtureDatabase();
    try {
      heartbeatActionEvent(db, "heartbeat-action-1", 501);
      heartbeatActionEvent(db, "heartbeat-action-2", 501);

      const summary = runGuardianDecisionOrchestratorOnce(db, {
        now: new Date("2026-06-18T00:03:00Z")
      });
      const [decision] = listPiGuardianDecisions(db, { decisionKind: "recovery", issueId: 501, projectId: "demo" });

      expect(summary).toMatchObject({ created: 1, lease_skipped: 0, merged: 1, scanned: 2 });
      expect(decision).toMatchObject({ state: "proposed" });
      expect(mergeMeta(decision)).toMatchObject({
        base_key: "recovery:demo:issue:501:issue.enqueue",
        event_count: 2
      });
      expect(listPiActions(db, { issueId: 501 })).toHaveLength(0);

      const settled = runGuardianDecisionOrchestratorOnce(db, {
        now: new Date("2026-06-18T00:03:31Z")
      });

      expect(settled).toMatchObject({ leases_acquired: 1, scanned: 0 });
      expect(listPiActions(db, { issueId: 501 })[0]).toMatchObject({
        action_type: "issue.enqueue",
        gate_decision: "ask",
        guardian_decision_id: decision.id,
        legacy_bypass_reason: "",
        status: "pending"
      });
      expect(listPiGuardianDecisions(db, { decisionKind: "recovery", issueId: 501, projectId: "demo" })[0])
        .toMatchObject({ state: "completed" });
    } finally {
      db.close();
    }
  });

  test("skips action creation while the same guardian action lease is held", async () => {
    const db = await openFixtureDatabase();
    try {
      createPiAction(db, {
        action_type: "issue.enqueue",
        id: "held-guardian-action",
        issue_id: 502,
        lease_expires_at: "2026-06-18T00:09:00Z",
        lease_key: "demo:issue:502:issue.enqueue",
        project_id: "demo",
        status: "executing"
      });
      heartbeatActionEvent(db, "heartbeat-action-held-2", 502);
      const queued = runGuardianDecisionOrchestratorOnce(db, { now: new Date("2026-06-18T00:04:10Z") });
      const summary = runGuardianDecisionOrchestratorOnce(db, { now: new Date("2026-06-18T00:04:41Z") });
      const decisions = listPiGuardianDecisions(db, { decisionKind: "recovery", issueId: 502, projectId: "demo" });

      expect(queued).toMatchObject({ created: 1, scanned: 1 });
      expect(summary).toMatchObject({ lease_skipped: 1, leases_acquired: 0, scanned: 0 });
      expect(listPiActions(db, { issueId: 502 }).map((action) => action.id)).toEqual(["held-guardian-action"]);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ rationale: "lease_held", state: "skipped" });
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-guardian-decision-actions-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function heartbeatActionEvent(db: RunnerDatabase, id: string, issueID: number): void {
  createPiGuardianEvent(db, {
    event_type: "guardian.heartbeat.action_candidate",
    id,
    idempotency_key: `guardian.heartbeat.action_candidate:demo:${issueID}:issue.enqueue:${id}`,
    issue_id: issueID,
    normalized_payload_json: {
      action_type: "issue.enqueue",
      diagnosis_code: "issue.enqueue",
      original_payload: { issue_id: issueID },
      rationale: "todo issue has no active session",
      risk_level: "medium",
      signal_type: "heartbeat.action_candidate"
    },
    project_id: "demo",
    severity: "watch",
    source: "heartbeat",
    source_event_id: id,
    status: "pending"
  });
}

function mergeMeta(decision: PiGuardianDecision): Record<string, unknown> {
  const evidence = JSON.parse(decision.evidence_json) as Array<Record<string, unknown>>;
  const row = evidence.find((item) => typeof item.guardian_decision_merge === "object");
  return row?.guardian_decision_merge as Record<string, unknown>;
}
