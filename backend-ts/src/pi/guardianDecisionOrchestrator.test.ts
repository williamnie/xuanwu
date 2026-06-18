import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import {
  createPiGuardianEvent,
  listPiGuardianDecisions,
  listPiGuardianEvents,
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

describe("PI Guardian decision orchestrator merge window", () => {
  test("keeps same issue and diagnosis watch signals in one active decision", async () => {
    const db = await openFixtureDatabase();
    try {
      for (let index = 1; index <= 5; index++) {
        signalEvent(db, { id: `watch-${index}`, issueID: 101, severity: "watch" });
      }

      const summary = runGuardianDecisionOrchestratorOnce(db, {
        now: new Date("2026-06-18T00:00:00Z")
      });
      const decisions = listPiGuardianDecisions(db, {
        decisionKind: "recovery",
        issueId: 101,
        projectId: "demo"
      });

      expect(summary).toMatchObject({ created: 1, merged: 4, scanned: 5 });
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({
        cooldown_until: "2026-06-18T00:00:30Z",
        state: "proposed"
      });
      expect(mergeMeta(decisions[0])).toMatchObject({
        base_key: "recovery:demo:issue:101:provider_timeout",
        event_count: 5,
        merge_key: "recovery:demo:issue:101:provider_timeout:watch",
        severity: "watch",
        window_ms: 30_000
      });
      expect(listPiGuardianEvents(db, { issueId: 101 }).map((event) => event.status))
        .toEqual(["consumed", "consumed", "consumed", "consumed", "consumed"]);
    } finally {
      db.close();
    }
  });

  test("merges high-volume info signals into one 120s decision window", async () => {
    const db = await openFixtureDatabase();
    try {
      for (let index = 1; index <= 4; index++) {
        notificationEvent(db, { id: `info-${index}`, issueID: 102, severity: "info" });
      }

      const summary = runGuardianDecisionOrchestratorOnce(db, {
        now: new Date("2026-06-18T00:03:00Z")
      });
      const [decision] = listPiGuardianDecisions(db, {
        decisionKind: "notification",
        issueId: 102,
        projectId: "demo"
      });

      expect(summary).toMatchObject({ created: 1, merged: 3, scanned: 4 });
      expect(mergeMeta(decision)).toMatchObject({
        event_count: 4,
        severity: "info",
        window_ms: 120_000
      });
    } finally {
      db.close();
    }
  });

  test("breaks an ordinary merge window when severity upgrades to actionable", async () => {
    const db = await openFixtureDatabase();
    try {
      signalEvent(db, { id: "watch-before-upgrade", issueID: 201, severity: "watch" });
      runGuardianDecisionOrchestratorOnce(db, { now: new Date("2026-06-18T00:00:00Z") });
      signalEvent(db, { id: "actionable-upgrade", issueID: 201, severity: "actionable" });

      const summary = runGuardianDecisionOrchestratorOnce(db, {
        now: new Date("2026-06-18T00:00:10Z")
      });
      const decisions = listPiGuardianDecisions(db, {
        decisionKind: "recovery",
        issueId: 201,
        projectId: "demo"
      });
      const active = activeDecisions(decisions);

      expect(summary).toMatchObject({ break_window: 1, created: 1, scanned: 1 });
      expect(decisions.map((decision) => decision.state).sort()).toEqual(["proposed", "superseded"]);
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({ cooldown_until: "", state: "proposed" });
      expect(mergeMeta(active[0])).toMatchObject({
        base_key: "recovery:demo:issue:201:provider_timeout",
        event_count: 1,
        merge_key: "recovery:demo:issue:201:provider_timeout:actionable",
        severity: "actionable",
        window_ms: 0
      });
    } finally {
      db.close();
    }
  });

  test("breaks an ordinary merge window when severity upgrades to urgent", async () => {
    const db = await openFixtureDatabase();
    try {
      signalEvent(db, { id: "watch-before-urgent", issueID: 202, severity: "watch" });
      runGuardianDecisionOrchestratorOnce(db, { now: new Date("2026-06-18T00:00:00Z") });
      signalEvent(db, { id: "urgent-upgrade", issueID: 202, severity: "urgent" });

      const summary = runGuardianDecisionOrchestratorOnce(db, {
        now: new Date("2026-06-18T00:00:10Z")
      });
      const active = activeDecisions(listPiGuardianDecisions(db, {
        decisionKind: "recovery",
        issueId: 202,
        projectId: "demo"
      }));

      expect(summary).toMatchObject({ break_window: 1, bypassed: 1, created: 1, scanned: 1 });
      expect(active).toHaveLength(1);
      expect(mergeMeta(active[0])).toMatchObject({
        base_key: "recovery:demo:issue:202:provider_timeout",
        merge_key: "recovery:demo:issue:202:provider_timeout:urgent",
        severity: "urgent",
        window_ms: 0
      });
    } finally {
      db.close();
    }
  });

  test("does not let event severity downgrade deterministic actionable diagnosis", async () => {
    const db = await openFixtureDatabase();
    try {
      signalEvent(db, {
        diagnosisCode: "missing_user_input",
        id: "pi-downgrade-attempt",
        issueID: 203,
        severity: "info"
      });

      const summary = runGuardianDecisionOrchestratorOnce(db, {
        now: new Date("2026-06-18T00:00:00Z")
      });
      const [decision] = listPiGuardianDecisions(db, {
        decisionKind: "recovery",
        issueId: 203,
        projectId: "demo"
      });

      expect(summary).toMatchObject({ created: 1, scanned: 1 });
      expect(decision).toMatchObject({
        decision: "needs_user",
        requires_user: 1
      });
      expect(mergeMeta(decision)).toMatchObject({
        merge_key: "recovery:demo:issue:203:missing_user_input:actionable",
        severity: "actionable"
      });
    } finally {
      db.close();
    }
  });

  test("routes unknown diagnosis to needs_user instead of aggregate", async () => {
    const db = await openFixtureDatabase();
    try {
      signalEvent(db, {
        diagnosisCode: "future_unknown_code",
        id: "unknown-diagnosis",
        issueID: 204,
        severity: "watch"
      });

      runGuardianDecisionOrchestratorOnce(db, { now: new Date("2026-06-18T00:00:00Z") });
      const [decision] = listPiGuardianDecisions(db, {
        decisionKind: "recovery",
        issueId: 204,
        projectId: "demo"
      });

      expect(decision).toMatchObject({
        decision: "needs_user",
        requires_user: 1
      });
      expect(mergeMeta(decision)).toMatchObject({
        merge_key: "recovery:demo:issue:204:future_unknown_code:actionable"
      });
    } finally {
      db.close();
    }
  });


  test("does not create another decision while a completed diagnosis is cooling down", async () => {
    const db = await openFixtureDatabase();
    try {
      signalEvent(db, { id: "cooldown-first", issueID: 301, severity: "watch" });
      runGuardianDecisionOrchestratorOnce(db, { now: new Date("2026-06-18T00:00:00Z") });
      const [first] = listPiGuardianDecisions(db, { issueId: 301, projectId: "demo" });
      transitionPiGuardianDecisionState(db, first.id, {
        cooldownUntil: "2026-06-18T00:05:00Z",
        to: "completed"
      });
      signalEvent(db, { id: "cooldown-repeat", issueID: 301, severity: "watch" });

      const summary = runGuardianDecisionOrchestratorOnce(db, {
        now: new Date("2026-06-18T00:01:00Z")
      });

      expect(summary).toMatchObject({ cooldown_suppressed: 1, scanned: 1 });
      expect(listPiGuardianDecisions(db, { issueId: 301, projectId: "demo" })).toHaveLength(1);
      expect(listPiGuardianEvents(db, { issueId: 301 }).map((event) => event.status))
        .toEqual(["consumed", "consumed"]);
    } finally {
      db.close();
    }
  });

  test("does not wait on urgent or approval decisions", async () => {
    const db = await openFixtureDatabase();
    try {
      signalEvent(db, { id: "urgent-now", issueID: 401, severity: "urgent" });
      signalEvent(db, { id: "urgent-next", issueID: 401, severity: "urgent" });
      approvalEvent(db, "approval-now", 402);
      approvalEvent(db, "approval-next", 402);

      const summary = runGuardianDecisionOrchestratorOnce(db, {
        now: new Date("2026-06-18T00:02:00Z")
      });
      const decisions = listPiGuardianDecisions(db, { projectId: "demo" });

      expect(summary).toMatchObject({ bypassed: 4, created: 4, scanned: 4 });
      expect(decisions).toHaveLength(4);
      expect(decisions.map((decision) => decision.decision_kind).sort()).toEqual([
        "approval",
        "approval",
        "recovery",
        "recovery"
      ]);
      for (const decision of decisions) {
        expect(decision.cooldown_until).toBe("");
        expect(mergeMeta(decision)).toMatchObject({ window_ms: 0 });
      }
    } finally {
      db.close();
    }
  });

});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-guardian-decision-merge-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function signalEvent(
  db: RunnerDatabase,
  input: { diagnosisCode?: string; id: string; issueID: number; severity: string }
): void {
  const diagnosisCode = input.diagnosisCode ?? "provider_timeout";
  createPiGuardianEvent(db, {
    event_type: "guardian.supervisor.candidate",
    id: input.id,
    idempotency_key: `guardian.supervisor.candidate:demo:${input.issueID}:${input.id}`,
    issue_id: input.issueID,
    normalized_payload_json: {
      diagnosis_code: diagnosisCode,
      signal_type: "supervisor.candidate"
    },
    project_id: "demo",
    severity: input.severity,
    source: "supervisor",
    source_event_id: input.id,
    status: "pending"
  });
}


function notificationEvent(
  db: RunnerDatabase,
  input: { id: string; issueID: number; severity: string }
): void {
  createPiGuardianEvent(db, {
    event_type: "guardian.notification.intent",
    id: input.id,
    idempotency_key: `guardian.notification.intent:demo:${input.issueID}:${input.id}`,
    issue_id: input.issueID,
    normalized_payload_json: {
      kind: "issue_created",
      signal_type: "notification.intent"
    },
    project_id: "demo",
    severity: input.severity,
    source: "notification",
    source_event_id: input.id,
    status: "pending"
  });
}

function approvalEvent(db: RunnerDatabase, id: string, issueID: number): void {
  createPiGuardianEvent(db, {
    event_type: "approval/requested",
    id,
    idempotency_key: `approval/requested:demo:${issueID}:${id}`,
    issue_id: issueID,
    normalized_payload_json: { approval_id: id, request_type: "command" },
    project_id: "demo",
    severity: "info",
    source: "provider",
    source_event_id: id,
    status: "pending"
  });
}

function activeDecisions(decisions: PiGuardianDecision[]): PiGuardianDecision[] {
  return decisions.filter((decision) => !["completed", "failed", "skipped", "superseded"].includes(decision.state));
}

function mergeMeta(decision: PiGuardianDecision): Record<string, unknown> {
  const evidence = JSON.parse(decision.evidence_json) as Array<Record<string, unknown>>;
  const row = evidence.find((item) => typeof item.guardian_decision_merge === "object");
  return row?.guardian_decision_merge as Record<string, unknown>;
}
