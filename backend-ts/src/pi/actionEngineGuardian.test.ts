import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createPiAction } from "../db/repositories/pi.ts";
import {
  acquireGuardianActionLease,
  createPendingPiAction
} from "./actionEngine.ts";
import type { PiGatePolicy } from "./actionGate.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
});

describe("PI action engine Guardian action outlet", () => {
  test("waits for delegated async mutations before returning their final action result", async () => {
    const db = await openFixtureDatabase();
    try {
      const result = await createPendingPiAction(db, {
        authorization: {
          authorizedActions: [{ action_type: "issue.comment", issue_id: 7, project_id: "demo" }],
          mode: "delegated",
          scope: { project_id: "demo" }
        }
      }, {
        actionType: "issue.comment",
        issueID: 7,
        payload: { body: "async", issue_id: 7 },
        projectID: "demo"
      }, async () => {
        await Promise.resolve();
        return { persisted: true };
      }) as Record<string, unknown>;

      expect(result).toMatchObject({
        decision: "execute",
        result: { persisted: true },
        status: "completed"
      });
    } finally {
      db.close();
    }
  });

  test("deduplicates guardian actions by idempotency key and marks legacy bypass actions", async () => {
    const db = await openFixtureDatabase();
    try {
      const first = createPendingPiAction(db, guardianContext(), guardianRequest()) as Record<string, unknown>;
      const second = createPendingPiAction(db, guardianContext(), guardianRequest()) as Record<string, unknown>;
      const legacy = createPendingPiAction(db, {}, {
        actionType: "issue.comment",
        issueID: 7,
        payload: { body: "legacy", issue_id: 7 },
        projectID: "demo"
      }) as Record<string, unknown>;
      const rows = db.sqlite.query<Record<string, unknown>, []>(
        `select before_snapshot_json, expected_state_json, guardian_decision_id, idempotency_key,
          legacy_bypass_reason from pi_actions order by created_at asc, id asc`
      ).all();

      expect(second.action_id).toBe(first.action_id);
      expect(first).toMatchObject({
        decision: "execute",
        guardian_decision_id: "decision-1",
        idempotency_key: "decision-1:issue.enqueue:7"
      });
      expect(legacy).toMatchObject({ decision: "execute", guardian_decision_id: "", idempotency_key: "" });
      expect(rows).toContainEqual(expect.objectContaining({
        before_snapshot_json: "{\"issue\":{\"status\":\"todo\",\"updated_at\":\"2026-06-18T00:00:00Z\"}}",
        guardian_decision_id: "decision-1",
        expected_state_json: "{\"issue_status\":\"todo\",\"issue_updated_at\":\"2026-06-18T00:00:00Z\"}",
        idempotency_key: "decision-1:issue.enqueue:7",
        legacy_bypass_reason: ""
      }));
      expect(rows).toContainEqual(expect.objectContaining({ legacy_bypass_reason: "legacy_direct_action" }));
    } finally {
      db.close();
    }
  });

  test("reports held guardian lease before duplicate action creation", async () => {
    const db = await openFixtureDatabase();
    try {
      createPiAction(db, {
        action_type: "issue.enqueue",
        id: "held-action",
        lease_expires_at: "2026-06-18T00:05:00Z",
        lease_key: "demo:issue:7:issue.enqueue",
        project_id: "demo",
        status: "executing"
      });

      expect(acquireGuardianActionLease(db, {
        actionType: "issue.enqueue",
        idempotencyKey: "decision-2:issue.enqueue:7",
        issueID: 7,
        now: new Date("2026-06-18T00:00:00Z"),
        owner: "worker-b",
        projectID: "demo"
      })).toMatchObject({
        action: expect.objectContaining({ id: "held-action" }),
        lease_key: "demo:issue:7:issue.enqueue",
        status: "held"
      });
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-action-engine-guardian-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function guardianContext() {
  return {
    authorization: delegatedPolicy(),
    guardianDecisionID: "decision-1",
    source: "pi_guardian_orchestrator"
  };
}

function guardianRequest() {
  return {
    actionType: "issue.enqueue",
    idempotencyKey: "decision-1:issue.enqueue:7",
    issueID: 7,
    payload: {
      before_snapshot: { issue: { status: "todo", updated_at: "2026-06-18T00:00:00Z" } },
      expected_issue_status: "todo",
      expected_issue_updated_at: "2026-06-18T00:00:00Z",
      issue_id: 7
    },
    projectID: "demo"
  };
}

function delegatedPolicy(): PiGatePolicy {
  return {
    allowed_actions: ["issue.enqueue"],
    authorizedActions: [{ action_type: "issue.enqueue", issue_id: 7, project_id: "demo" }],
    mode: "delegated",
    scope: { project_id: "demo" }
  };
}
