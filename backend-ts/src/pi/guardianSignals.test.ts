import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listPiGuardianEvents } from "../db/repositories/pi.ts";
import {
  guardianSignalsFromHeartbeatActions,
  guardianSignalsFromSupervisorCandidates,
  writeGuardianSignals
} from "./guardianSignals.ts";

const tempRoots: string[] = [];
const NOW = new Date("2026-06-18T02:00:00Z");

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
});

describe("Guardian signals", () => {
  test("writes heartbeat action candidates to guardian inbox without creating PI actions", async () => {
    const db = await openFixtureDatabase();
    try {
      const signals = guardianSignalsFromHeartbeatActions([{
        action_type: "issue.enqueue",
        issue_id: 41,
        payload: { issue_id: 41, suggested_operation: "enqueue" },
        project_id: "demo",
        rationale: "todo issue has no active session",
        requires_confirmation: true,
        risk_level: "medium",
        source: "pi_heartbeat"
      }], { heartbeatID: "hb-1", now: NOW, projectID: "demo" });
      const written = writeGuardianSignals(db, signals);

      expect(written).toEqual([expect.objectContaining({ action_type: "heartbeat.action_candidate", status: "signaled" })]);
      expect(listPiGuardianEvents(db, { projectId: "demo" })).toEqual([
        expect.objectContaining({
          event_type: "guardian.heartbeat.action_candidate",
          issue_id: 41,
          severity: "watch",
          source: "heartbeat",
          status: "pending"
        })
      ]);
      expect(rowCount(db, "pi_actions")).toBe(0);
    } finally {
      db.close();
    }
  });

  test("writes supervisor candidates with deterministic classification", async () => {
    const db = await openFixtureDatabase();
    try {
      const signals = guardianSignalsFromSupervisorCandidates([{
        budget_remaining: 2,
        diagnosis_code: "requires_human_decision",
        evidence_refs: ["provider_error"],
        issue_id: 42,
        project_id: "demo",
        provider_error_category: "auth",
        provider_session_id: "thread-42",
        ready: true,
        reason: "API returned 401 unauthorized",
        run_id: "run-42",
        stale_gap_seconds: 600,
        wait_until: ""
      }], { heartbeatID: "hb-1", now: NOW, projectID: "demo" });
      writeGuardianSignals(db, signals);

      const [event] = listPiGuardianEvents(db, { projectId: "demo" });
      expect(event).toMatchObject({
        event_type: "guardian.supervisor.candidate",
        issue_id: 42,
        severity: "actionable"
      });
      expect(JSON.parse(event?.normalized_payload_json ?? "{}")).toMatchObject({
        classification: { failure_class: "needs_context", severity: "actionable" },
        diagnosis_code: "requires_human_decision",
        provider_error_category: "auth",
        signal_type: "supervisor.candidate"
      });
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-guardian-signals-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function rowCount(db: RunnerDatabase, table: string): number {
  return db.sqlite.query<{ count: number }, []>(`select count(*) as count from ${table}`).get()?.count ?? 0;
}
