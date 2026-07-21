import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../database.ts";
import {
  ackPiGuardianAlert,
  getPiGuardianWatchdogStatus,
  listPiGuardianAlerts,
  markPiGuardianAlertRetry,
  resolvePiGuardianAlert,
  updatePiGuardianAlert,
  upsertPiGuardianAlert,
  upsertPiGuardianWatchdogStatus
} from "../pi.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI guardian watchdog repositories", () => {
  test("refreshes the same open outage alert and redacts message evidence", async () => {
    const db = await openFixtureDatabase();
    try {
      const first = upsertPiGuardianAlert(db, {
        alert_type: "outbox_stalled",
        evidence_json: {
          authorization: "Bearer fixture-token",
          path: "/Users/example/project/.env"
        },
        id: "alert-1",
        message: "Outbox stalled with CODEX_RUNNER_AUTH_TOKEN=fixture-token at /Users/example/project/.env",
        project_id: "demo",
        watchdog_seen_at: "2026-06-19T00:00:00Z"
      });
      const refreshed = upsertPiGuardianAlert(db, {
        alert_type: "outbox_stalled",
        evidence_json: {
          api_key: "new-secret",
          log: "retry from /tmp/private/outbox.log"
        },
        id: "alert-duplicate",
        message: "Still stalled API_KEY=new-secret at /tmp/private/outbox.log",
        project_id: "demo",
        watchdog_seen_at: "2026-06-19T00:05:00Z"
      });

      expect(refreshed.id).toBe(first.id);
      expect(refreshed.watchdog_seen_at).toBe("2026-06-19T00:05:00Z");
      expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" })).toHaveLength(1);
      expect(refreshed.message).not.toContain("new-secret");
      expect(refreshed.message).not.toContain("/tmp/private");
      expect(refreshed.evidence_json).not.toContain("new-secret");
      expect(refreshed.evidence_json).not.toContain("/tmp/private");
      expect(refreshed.evidence_json).toContain("[redacted]");
      expect(refreshed.evidence_json).toContain("[redacted-path]");
    } finally {
      db.close();
    }
  });

  test("updates alert lifecycle through retry ack and resolve", async () => {
    const db = await openFixtureDatabase();
    try {
      upsertPiGuardianAlert(db, {
        alert_type: "pi_runtime_down",
        id: "alert-lifecycle",
        message: "PI runtime unavailable",
        project_id: "demo"
      });
      const updated = updatePiGuardianAlert(db, "alert-lifecycle", {
        message: "PI runtime unavailable after retry",
        severity: "critical"
      });
      const retry = markPiGuardianAlertRetry(db, "alert-lifecycle", {
        direct_feishu_error: "POST failed with Bearer fixture-token",
        next_retry_at: "2026-06-19T00:15:00Z"
      });
      const acked = ackPiGuardianAlert(db, "alert-lifecycle");
      const resolved = resolvePiGuardianAlert(db, "alert-lifecycle", {
        message: "PI runtime recovered"
      });

      expect(updated).toMatchObject({ message: "PI runtime unavailable after retry", severity: "critical" });
      expect(retry).toMatchObject({
        direct_feishu_state: "retry",
        next_retry_at: "2026-06-19T00:15:00Z",
        retry_count: 1
      });
      expect(retry.direct_feishu_error).not.toContain("fixture-token");
      expect(acked.status).toBe("acked");
      expect(resolved).toMatchObject({ message: "PI runtime recovered", status: "resolved" });
    } finally {
      db.close();
    }
  });

  test("preserves resolved history and gives a deterministic-id recurrence a fresh incident id", async () => {
    const db = await openFixtureDatabase();
    try {
      const first = upsertPiGuardianAlert(db, {
        alert_type: "handoff_tracker_update_failed",
        id: "deterministic-alert",
        message: "first incident",
        project_id: "demo"
      });
      resolvePiGuardianAlert(db, first.id, { message: "recovered" });
      const recurrence = upsertPiGuardianAlert(db, {
        alert_type: "handoff_tracker_update_failed",
        id: "deterministic-alert",
        message: "recurrence",
        project_id: "demo"
      });

      expect(recurrence.id).not.toBe(first.id);
      expect(recurrence).toMatchObject({ message: "recurrence", status: "open" });
      expect(listPiGuardianAlerts(db, { projectId: "demo", status: "resolved" })).toHaveLength(1);
      expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" })).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("upserts singleton watchdog liveness status", async () => {
    const db = await openFixtureDatabase();
    try {
      const first = upsertPiGuardianWatchdogStatus(db, {
        checked_components_json: [{ component: "outbox", lag_path: "/Users/example/outbox.log" }],
        last_error: "CODEX_RUNNER_AUTH_TOKEN=fixture-token at /Users/example/outbox.log",
        last_seen_at: "2026-06-19T00:00:00Z"
      });
      const second = upsertPiGuardianWatchdogStatus(db, {
        checked_components_json: [{ component: "outbox", status: "ok" }],
        last_error: "",
        last_seen_at: "2026-06-19T00:01:00Z",
        last_success_at: "2026-06-19T00:01:00Z"
      });
      const row = db.sqlite.query<{ count: number }, []>(
        "select count(*) as count from pi_guardian_watchdog_status"
      ).get();

      expect(first.singleton_id).toBe(1);
      expect(second).toMatchObject({
        last_seen_at: "2026-06-19T00:01:00Z",
        last_success_at: "2026-06-19T00:01:00Z",
        singleton_id: 1
      });
      expect(row?.count).toBe(1);
      expect(getPiGuardianWatchdogStatus(db)).toMatchObject(second);
      expect(first.last_error).not.toContain("fixture-token");
      expect(first.last_error).not.toContain("/Users/example");
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-watchdog-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}
