import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import {
  createPiGuardianEvent,
  listPiGuardianDecisions,
  transitionPiGuardianDecisionState,
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

describe("PI Guardian decision orchestrator rate limit and backpressure", () => {
  test("defers project info/watch decisions after three PI turns per minute", async () => {
    const db = await openFixtureDatabase();
    const now = new Date();
    try {
      for (let index = 1; index <= 4; index++) {
        signalEvent(db, { id: `project-limit-${index}`, issueID: 500 + index, severity: "watch" });
      }

      const summary = runGuardianDecisionOrchestratorOnce(db, { now });
      const decisions = listPiGuardianDecisions(db, { projectId: "demo" });
      const deferred = decisions.find((decision) => decision.state === "deferred");

      expect(summary).toMatchObject({ created: 3, deferred: 1, scanned: 4 });
      expect(decisions.map((decision) => decision.state).sort()).toEqual([
        "deferred",
        "proposed",
        "proposed",
        "proposed"
      ]);
      expect(deferred?.rationale).toContain("backpressure_deferred");
      expect(rateLimitMeta(deferred!)).toMatchObject({ limit: 3, scope: "project" });
    } finally {
      db.close();
    }
  });

  test("defers non-urgent globally after ten PI turns per minute but lets urgent bypass", async () => {
    const db = await openFixtureDatabase();
    const now = new Date();
    try {
      for (let index = 1; index <= 10; index++) {
        signalEvent(db, {
          id: `global-limit-${index}`,
          issueID: 600 + index,
          projectID: `project-${index}`,
          severity: "watch"
        });
      }
      signalEvent(db, {
        id: "global-deferred-watch",
        issueID: 700,
        projectID: "overflow-project",
        severity: "watch"
      });
      signalEvent(db, {
        id: "global-urgent-bypass",
        issueID: 701,
        projectID: "overflow-project",
        severity: "urgent"
      });

      const summary = runGuardianDecisionOrchestratorOnce(db, { now });
      const deferred = listPiGuardianDecisions(db, { issueId: 700, projectId: "overflow-project" })[0];
      const urgent = listPiGuardianDecisions(db, { issueId: 701, projectId: "overflow-project" })[0];

      expect(summary).toMatchObject({ bypassed: 1, created: 11, deferred: 1, scanned: 12 });
      expect(deferred).toMatchObject({ state: "deferred" });
      expect(rateLimitMeta(deferred)).toMatchObject({ limit: 10, scope: "global" });
      expect(urgent).toMatchObject({ cooldown_until: "", state: "proposed" });
      expect(mergeMeta(urgent)).toMatchObject({ severity: "urgent", window_ms: 0 });
    } finally {
      db.close();
    }
  });

  test("reschedules deferred decisions after their backpressure cooldown", async () => {
    const db = await openFixtureDatabase();
    const now = new Date();
    try {
      for (let index = 1; index <= 4; index++) {
        signalEvent(db, { id: `reschedule-${index}`, issueID: 800 + index, severity: "watch" });
      }
      const first = runGuardianDecisionOrchestratorOnce(db, { now });
      const deferredBefore = listPiGuardianDecisions(db, { projectId: "demo" })
        .find((decision) => decision.state === "deferred");

      const second = runGuardianDecisionOrchestratorOnce(db, {
        now: new Date(now.getTime() + 61_000)
      });
      const rescheduled = listPiGuardianDecisions(db, { projectId: "demo" })
        .filter((decision) => decision.id === deferredBefore?.id);

      expect(first).toMatchObject({ deferred: 1 });
      expect(second).toMatchObject({ rescheduled: 1, scanned: 0 });
      expect(rescheduled).toHaveLength(1);
      expect(rescheduled[0]).toMatchObject({ state: "proposed" });
    } finally {
      db.close();
    }
  });

  test("defers run-group digest decisions within two minutes", async () => {
    const db = await openFixtureDatabase();
    const now = new Date();
    try {
      notificationEvent(db, {
        id: "group-first",
        issueID: 901,
        runGroupID: "group-a",
        severity: "info"
      });
      notificationEvent(db, {
        id: "group-second",
        issueID: 902,
        runGroupID: "group-a",
        severity: "info"
      });

      const summary = runGuardianDecisionOrchestratorOnce(db, { now });
      const decisions = listPiGuardianDecisions(db, { projectId: "demo" });
      const deferred = decisions.find((decision) => decision.state === "deferred");

      expect(summary).toMatchObject({ created: 1, deferred: 1, scanned: 2 });
      expect(deferred).toMatchObject({ decision_kind: "notification", run_group_id: "group-a" });
      expect(rateLimitMeta(deferred!)).toMatchObject({ scope: "run_group" });
    } finally {
      db.close();
    }
  });

  test("defers repeated recovery decisions for the same issue diagnosis for five minutes", async () => {
    const db = await openFixtureDatabase();
    const now = new Date();
    try {
      signalEvent(db, { id: "recovery-first", issueID: 950, severity: "watch" });
      runGuardianDecisionOrchestratorOnce(db, { now });
      const [first] = listPiGuardianDecisions(db, { issueId: 950, projectId: "demo" });
      transitionPiGuardianDecisionState(db, first.id, { to: "completed" });
      signalEvent(db, { id: "recovery-repeat", issueID: 950, severity: "watch" });

      const summary = runGuardianDecisionOrchestratorOnce(db, {
        now: new Date(now.getTime() + 120_000)
      });
      const deferred = listPiGuardianDecisions(db, { issueId: 950, projectId: "demo" })
        .find((decision) => decision.state === "deferred");

      expect(summary).toMatchObject({ deferred: 1, scanned: 1 });
      expect(rateLimitMeta(deferred!)).toMatchObject({ scope: "recovery" });
    } finally {
      db.close();
    }
  });
});


async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-guardian-rate-limit-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function signalEvent(
  db: RunnerDatabase,
  input: { id: string; issueID: number; projectID?: string; severity: string }
): void {
  const projectID = input.projectID ?? "demo";
  createPiGuardianEvent(db, {
    event_type: "guardian.supervisor.candidate",
    id: input.id,
    idempotency_key: `guardian.supervisor.candidate:${projectID}:${input.issueID}:${input.id}`,
    issue_id: input.issueID,
    normalized_payload_json: {
      diagnosis_code: "provider_timeout",
      signal_type: "supervisor.candidate"
    },
    project_id: projectID,
    severity: input.severity,
    source: "supervisor",
    source_event_id: input.id,
    status: "pending"
  });
}

function notificationEvent(
  db: RunnerDatabase,
  input: { id: string; issueID: number; runGroupID: string; severity: string }
): void {
  createPiGuardianEvent(db, {
    event_type: "issue.status_changed",
    id: input.id,
    idempotency_key: `issue.status_changed:demo:${input.issueID}:${input.id}`,
    issue_id: input.issueID,
    normalized_payload_json: {
      diagnosis_code: "digest",
      signal_type: "lifecycle"
    },
    project_id: "demo",
    run_group_id: input.runGroupID,
    severity: input.severity,
    source: "issue_events",
    source_event_id: input.id,
    status: "pending"
  });
}

function mergeMeta(decision: PiGuardianDecision): Record<string, unknown> {
  const evidence = JSON.parse(decision.evidence_json) as Array<Record<string, unknown>>;
  const row = evidence.find((item) => typeof item.guardian_decision_merge === "object");
  return row?.guardian_decision_merge as Record<string, unknown>;
}

function rateLimitMeta(decision: PiGuardianDecision): Record<string, unknown> {
  const evidence = JSON.parse(decision.evidence_json) as Array<Record<string, unknown>>;
  const row = evidence.find((item) => typeof item.guardian_decision_rate_limit === "object");
  return row?.guardian_decision_rate_limit as Record<string, unknown>;
}
