import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../database.ts";
import {
  claimPiGuardianDecisionLease,
  getPiGuardianDecision,
  listPiGuardianDecisions,
  transitionPiGuardianDecisionState,
  upsertPiGuardianDecision
} from "./guardianDecisions.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI Guardian decisions", () => {
  test("keeps one row per idempotency key and never stores raw PI text", async () => {
    const db = await openFixtureDatabase();
    try {
      const first = upsertPiGuardianDecision(db, {
        actions_json: [{ command: "cat /Users/example/project/.env", secret: "fixture-secret" }],
        authority: "pi",
        decision: "approve",
        decision_kind: "approval",
        evidence_json: [{ summary: "CODEX_API_KEY=fixture-secret in /Users/example/project" }],
        id: "decision-1",
        idempotency_key: "approval:demo:101:approval-1",
        issue_id: 101,
        project_id: "demo",
        rationale: "PI says CODEX_API_KEY=fixture-secret under /Users/example/project is okay",
        raw_pi_text_ref: "Raw PI output: CODEX_API_KEY=fixture-secret\n/Users/example/project",
        state: "completed"
      });
      const duplicate = upsertPiGuardianDecision(db, {
        decision: "noop",
        decision_kind: "approval",
        id: "decision-duplicate",
        idempotency_key: "approval:demo:101:approval-1",
        issue_id: 101,
        project_id: "demo",
        raw_pi_text_ref: "Another raw PI answer with fixture-secret",
        state: "proposed"
      });
      const stored = getPiGuardianDecision(db, first.id);

      expect(duplicate.id).toBe(first.id);
      expect(listPiGuardianDecisions(db, { projectId: "demo", issueId: 101 })).toHaveLength(1);
      expect(stored).toMatchObject({ id: "decision-1", raw_pi_text_ref: "", state: "completed" });
      expect(stored?.rationale).not.toContain("fixture-secret");
      expect(stored?.rationale).not.toContain("/Users/example");
      expect(stored?.evidence_json).not.toContain("fixture-secret");
      expect(stored?.evidence_json).not.toContain("/Users/example");
      expect(stored?.actions_json).not.toContain("fixture-secret");
      expect(stored?.actions_json).not.toContain("/Users/example");
    } finally {
      db.close();
    }
  });

  test("enforces guarded state transitions without terminal regression", async () => {
    const db = await openFixtureDatabase();
    try {
      const decision = upsertPiGuardianDecision(db, {
        decision: "resume_session",
        decision_kind: "recovery",
        id: "decision-state",
        idempotency_key: "recovery:demo:201:timeout:bucket-1",
        issue_id: 201,
        project_id: "demo"
      });
      const approved = transitionPiGuardianDecisionState(db, decision.id, {
        from: "proposed",
        to: "approved"
      });

      expect(approved.state).toBe("approved");
      expect(() => transitionPiGuardianDecisionState(db, decision.id, {
        from: "proposed",
        to: "executing"
      })).toThrow("expected state");
      expect(transitionPiGuardianDecisionState(db, decision.id, { to: "executing" }).state).toBe("executing");
      const completed = transitionPiGuardianDecisionState(db, decision.id, { to: "completed" });
      const deferred = upsertPiGuardianDecision(db, {
        decision: "retry_issue",
        decision_kind: "recovery",
        id: "decision-deferred",
        idempotency_key: "recovery:demo:202:timeout:bucket-1",
        issue_id: 202,
        project_id: "demo"
      });

      expect(completed).toMatchObject({ lease_expires_at: "", lease_owner: "", state: "completed" });
      expect(() => transitionPiGuardianDecisionState(db, decision.id, { to: "approved" }))
        .toThrow("cannot transition PI guardian decision decision-state from completed to approved");
      expect(transitionPiGuardianDecisionState(db, deferred.id, {
        cooldownUntil: "2026-06-18T00:05:00Z",
        to: "deferred"
      })).toMatchObject({ cooldown_until: "2026-06-18T00:05:00Z", state: "deferred" });
      expect(transitionPiGuardianDecisionState(db, deferred.id, { to: "approved" }).state).toBe("approved");
    } finally {
      db.close();
    }
  });

  test("claims leases only after cooldown and prevents concurrent owners", async () => {
    const db = await openFixtureDatabase();
    try {
      const decision = upsertPiGuardianDecision(db, {
        cooldown_until: "2026-06-18T00:01:00Z",
        decision: "retry_issue",
        decision_kind: "recovery",
        id: "decision-lease",
        idempotency_key: "recovery:demo:301:rate_limited:bucket-1",
        issue_id: 301,
        project_id: "demo",
        state: "approved"
      });

      expect(claimPiGuardianDecisionLease(db, decision.id, {
        now: new Date("2026-06-18T00:00:30Z"),
        owner: "worker-a",
        ttlMs: 30_000
      })).toBeNull();
      const leased = claimPiGuardianDecisionLease(db, decision.id, {
        now: new Date("2026-06-18T00:01:01Z"),
        owner: "worker-a",
        ttlMs: 30_000
      });

      expect(leased).toMatchObject({
        lease_expires_at: "2026-06-18T00:01:31Z",
        lease_owner: "worker-a",
        state: "approved"
      });
      expect(claimPiGuardianDecisionLease(db, decision.id, {
        now: new Date("2026-06-18T00:01:02Z"),
        owner: "worker-b",
        ttlMs: 30_000
      })).toBeNull();
      expect(claimPiGuardianDecisionLease(db, decision.id, {
        now: new Date("2026-06-18T00:01:32Z"),
        owner: "worker-b",
        ttlMs: 30_000
      })).toMatchObject({ lease_owner: "worker-b" });
      expect(transitionPiGuardianDecisionState(db, decision.id, { to: "skipped" }))
        .toMatchObject({ lease_expires_at: "", lease_owner: "", state: "skipped" });
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-guardian-decisions-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}
