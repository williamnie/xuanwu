import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listSyncOutbox } from "../db/repositories/imReplyOutbox.ts";
import {
  createPiNotificationIntent,
  listPiGuardianAlerts,
  listPiGuardianDecisions,
  listPiNotificationIntents,
  upsertPiGuardianAlert
} from "../db/repositories/pi.ts";
import { runGuardianMissedIntentSweepOnce } from "./guardianMissedIntentSweep.ts";
import type { PiGuardianWatchdogComponent } from "./guardianWatchdog.ts";
import type { PiGuardianWatchdogSummary } from "./guardianWatchdog.ts";

const tempRoots: string[] = [];
const NOW = "2026-06-19T00:10:00Z";

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
});

describe("PI Guardian missed intent sweep", () => {
  test("creates one idempotent recovery digest for recovered outage window missed intents", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      insertOutageAlert(db, "outbox_stalled");
      insertMissedIntent(db, "intent-failed", { issueID: 901, kind: "issue_failed", state: "failed" });
      insertMissedIntent(db, "intent-ready", { issueID: 902, kind: "issue_done", state: "ready" });
      insertMissedIntent(db, "intent-overdue", {
        flushAfter: "2026-06-19T00:03:00Z",
        issueID: 903,
        kind: "issue_pending_verification",
        state: "aggregated"
      });

      const first = runGuardianMissedIntentSweepOnce(db, { now: NOW, watchdog: recoveredWatchdog("outbox") });
      const second = runGuardianMissedIntentSweepOnce(db, { now: NOW, watchdog: recoveredWatchdog("outbox") });
      const digests = recoveryDigests(db);
      const payload = JSON.parse(digests[0]?.payload_json ?? "{}");

      expect(first).toMatchObject({ errors: 0, missedIntents: 3, openAlerts: 1, summaries: 1, windows: 1 });
      expect(second).toMatchObject({ errors: 0, summaries: 0, windows: 1 });
      expect(digests).toHaveLength(1);
      expect(digests[0]).toMatchObject({ flush_reason: "recovery", state: "ready", target_channel: "feishu" });
      expect(payload).toMatchObject({ failed_count: 1, total_count: 4 });
      expect(payload.issues.map((issue: { issue_id: number }) => issue.issue_id).sort()).toEqual([901, 902, 903]);
      expect(listSyncOutbox(db, { source: "feishu" })).toHaveLength(0);
      expect(listPiGuardianDecisions(db)).toHaveLength(0);
      expect(listPiNotificationIntents(db, { issueId: 901 })[0]).toMatchObject({ state: "aggregated" });
    } finally {
      db.close();
    }
  });

  test("keeps open outage alert and records missed_digest_pending when digest target is unavailable", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      insertOutageAlert(db, "coordinator_stalled");

      const result = runGuardianMissedIntentSweepOnce(db, { now: NOW, watchdog: recoveredWatchdog("coordinator") });
      const alerts = listPiGuardianAlerts(db, { projectId: "demo", status: "open" });
      const pending = alerts.find((alert) => alert.alert_type === "missed_digest_pending");

      expect(result).toMatchObject({ errors: 0, openAlerts: 1, pending: 1, summaries: 1, windows: 1 });
      expect(recoveryDigests(db)).toHaveLength(1);
      expect(alerts.map((alert) => alert.alert_type).sort()).toEqual([
        "coordinator_stalled",
        "missed_digest_pending"
      ]);
      expect(pending).toMatchObject({ status: "open", ui_visible: 1 });
    } finally {
      db.close();
    }
  });

  test("keeps pending alert without recovery digest while digest pipeline remains unavailable", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      insertOutageAlert(db, "outbox_stalled");
      insertMissedIntent(db, "intent-pending", { issueID: 904, kind: "issue_done", state: "ready" });

      const result = runGuardianMissedIntentSweepOnce(db, {
        now: NOW,
        watchdog: {
          alerts: 0,
          checks: [
            { component: "outbox", ok: true },
            { component: "digest", ok: false }
          ],
          errors: 0,
          scanned: 2
        }
      });

      expect(result).toMatchObject({ pending: 1, skipped: 1, summaries: 0, windows: 1 });
      expect(recoveryDigests(db)).toHaveLength(0);
      expect(listPiGuardianAlerts(db, { alertType: "missed_digest_pending", status: "open" })).toHaveLength(1);
      expect(listPiNotificationIntents(db, { issueId: 904 })[0]).toMatchObject({ state: "ready" });
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-missed-sweep-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, created_at, updated_at)
     values (?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "2026-06-19T00:00:00Z", "2026-06-19T00:00:00Z"]
  );
}

function insertOutageAlert(db: RunnerDatabase, alertType: string): void {
  const alert = upsertPiGuardianAlert(db, {
    alert_type: alertType,
    evidence_json: { oldest_created_at: "2026-06-19T00:00:00Z" },
    message: `${alertType} during outage`,
    project_id: "demo",
    watchdog_seen_at: "2026-06-19T00:05:00Z"
  });
  db.sqlite.run("update pi_guardian_alerts set created_at=?, updated_at=? where id=?", [
    "2026-06-19T00:05:00Z", "2026-06-19T00:05:00Z", alert.id
  ]);
}

function insertMissedIntent(
  db: RunnerDatabase,
  id: string,
  input: { flushAfter?: string; issueID: number; kind: string; state: string }
): void {
  createPiNotificationIntent(db, {
    conversation_id: "feishu-chat-oc_group-20260619",
    error: input.state === "failed" ? "delivery failed" : "",
    flush_after_at: input.flushAfter,
    id,
    idempotency_key: id,
    issue_id: input.issueID,
    kind: input.kind,
    project_id: "demo",
    state: input.state,
    summary: `${input.kind} missed`,
    target_channel: "feishu"
  });
  db.sqlite.run("update pi_notification_intents set created_at=?, updated_at=? where id=?", [
    "2026-06-19T00:02:00Z", "2026-06-19T00:02:00Z", id
  ]);
}

function recoveryDigests(db: RunnerDatabase) {
  return listPiNotificationIntents(db, { kind: "digest" })
    .filter((intent) => intent.flush_reason === "recovery");
}

function recoveredWatchdog(component: PiGuardianWatchdogComponent): PiGuardianWatchdogSummary {
  return {
    alerts: 0,
    checks: [{ component, ok: true }],
    errors: 0,
    scanned: 1
  };
}
