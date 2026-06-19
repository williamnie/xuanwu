import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import {
  getPiGuardianWatchdogStatus,
  listPiGuardianAlerts,
  upsertPiGuardianWatchdogStatus
} from "../db/repositories/pi.ts";
import { runPiGuardianWatchdogOnce } from "./guardianWatchdog.ts";

const tempRoots: string[] = [];
const NOW = new Date("2026-06-19T01:00:00Z");
const STALE_MS = 60_000;

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI Guardian watchdog detector", () => {
  test("writes PI runtime alert, refreshes liveness, and avoids PI/outbox side effects", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      insertProjectPiSettings(db, "demo", "missing-agent");

      const result = runPiGuardianWatchdogOnce(db, { now: NOW, staleAfterMs: STALE_MS });
      const alerts = listPiGuardianAlerts(db, { projectId: "demo", status: "open" });

      expect(result).toMatchObject({ alerts: 1, errors: 0 });
      expect(result.checks.map((check) => check.component).sort()).toEqual([
        "approval", "coordinator", "digest", "inbox", "outbox", "pi_runtime", "scheduler"
      ]);
      expect(result.checks.find((check) => check.component === "pi_runtime")).toMatchObject({
        alert_type: "pi_runtime_down",
        ok: false,
        project_id: "demo"
      });
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        alert_type: "pi_runtime_down",
        project_id: "demo",
        status: "open",
        ui_visible: 1,
        watchdog_seen_at: "2026-06-19T01:00:00Z"
      });
      expect(getPiGuardianWatchdogStatus(db)).toMatchObject({
        last_error: "",
        last_seen_at: "2026-06-19T01:00:00Z",
        last_success_at: "2026-06-19T01:00:00Z"
      });
      expect(sideEffectCounts(db)).toEqual({
        conversations: 0,
        drafts: 0,
        intents: 0,
        outbox: 0
      });
    } finally {
      db.close();
    }
  });

  test("detects stuck outbox and refreshes the same open alert", async () => {
    const db = await openFixtureDatabase();
    try {
      insertStuckOutbox(db, "2026-06-19T00:00:00Z");

      const first = runPiGuardianWatchdogOnce(db, { now: NOW, staleAfterMs: STALE_MS });
      const firstAlert = listPiGuardianAlerts(db, { alertType: "outbox_stalled", status: "open" })[0];
      const second = runPiGuardianWatchdogOnce(db, {
        now: new Date("2026-06-19T01:05:00Z"),
        schedulerStaleAfterMs: 10 * 60_000,
        staleAfterMs: STALE_MS
      });
      const alerts = listPiGuardianAlerts(db, { alertType: "outbox_stalled", status: "open" });

      expect(first.checks.find((check) => check.component === "outbox")).toMatchObject({
        alert_type: "outbox_stalled",
        ok: false
      });
      expect(first.alerts).toBe(1);
      expect(second.alerts).toBe(1);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].id).toBe(firstAlert?.id);
      expect(alerts[0].watchdog_seen_at).toBe("2026-06-19T01:05:00Z");
      expect(sideEffectCounts(db)).toEqual({
        conversations: 0,
        drafts: 0,
        intents: 0,
        outbox: 1
      });
    } finally {
      db.close();
    }
  });

  test("detects coordinator digest approval scheduler and inbox issues", async () => {
    const db = await openFixtureDatabase();
    try {
      insertStaleNotificationIntent(db);
      insertOverdueRunGroup(db);
      insertFailedApprovalResolver(db);
      insertPendingGuardianInboxEvent(db);
      upsertPiGuardianWatchdogStatus(db, {
        last_seen_at: "2026-06-19T00:00:00Z",
        last_success_at: "2026-06-19T00:00:00Z"
      });

      const result = runPiGuardianWatchdogOnce(db, {
        now: NOW,
        schedulerStaleAfterMs: STALE_MS,
        staleAfterMs: STALE_MS
      });
      const alertTypes = listPiGuardianAlerts(db, { status: "open" })
        .map((alert) => alert.alert_type)
        .sort();

      expect(result.alerts).toBe(5);
      expect(alertTypes).toEqual([
        "approval_fast_path_error",
        "coordinator_stalled",
        "digest_flush_stalled",
        "guardian_inbox_stalled",
        "scheduler_stalled"
      ]);
    } finally {
      db.close();
    }
  });

  test("records detector failure in last_error without throwing", async () => {
    const db = await openFixtureDatabase();
    try {
      const result = runPiGuardianWatchdogOnce(db, {
        checks: [{
          component: "coordinator",
          run: () => {
            throw new Error("probe failed with API_KEY=fixture-token at /Users/demo/private.log");
          }
        }],
        now: NOW
      });
      const status = getPiGuardianWatchdogStatus(db);

      expect(result).toMatchObject({ alerts: 0, errors: 1 });
      expect(status).toMatchObject({
        last_seen_at: "2026-06-19T01:00:00Z",
        last_success_at: ""
      });
      expect(status?.last_error).toContain("[redacted]");
      expect(status?.last_error).not.toContain("fixture-token");
      expect(status?.last_error).not.toContain("/Users/demo");
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-guardian-watchdog-"));
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

function insertProjectPiSettings(db: RunnerDatabase, projectID: string, agentID: string): void {
  db.sqlite.run(
    `insert into project_pi_settings
     (project_id, pi_agent_id, auto_manage, max_actions_per_cycle, created_at, updated_at)
     values (?, ?, 1, 3, ?, ?)`,
    [projectID, agentID, "2026-06-19T00:00:00Z", "2026-06-19T00:00:00Z"]
  );
}

function insertStuckOutbox(db: RunnerDatabase, createdAt: string): void {
  db.sqlite.run(
    `insert into sync_outbox (source, reply_draft_id, content, status, created_at, updated_at)
     values ('feishu', 101, 'stuck message', 'pending', ?, ?)`,
    [createdAt, createdAt]
  );
}

function insertStaleNotificationIntent(db: RunnerDatabase): void {
  db.sqlite.run(
    `insert into pi_notification_intents
     (id, idempotency_key, project_id, kind, state, created_at, updated_at)
     values ('intent-stale', 'intent-stale-key', 'demo', 'issue_done', 'ready', ?, ?)`,
    ["2026-06-19T00:00:00Z", "2026-06-19T00:00:00Z"]
  );
}

function insertOverdueRunGroup(db: RunnerDatabase): void {
  db.sqlite.run(
    `insert into pi_run_groups
     (id, project_id, status, deadline_at, created_at, updated_at)
     values ('group-overdue', 'demo', 'active', ?, ?, ?)`,
    ["2026-06-19T00:10:00Z", "2026-06-19T00:00:00Z", "2026-06-19T00:00:00Z"]
  );
}

function insertFailedApprovalResolver(db: RunnerDatabase): void {
  db.sqlite.run(
    `insert into pi_approval_requests
     (approval_id, project_id, resolver_status, created_at, updated_at)
     values ('approval-failed', 'demo', 'resolve_failed', ?, ?)`,
    ["2026-06-19T00:00:00Z", "2026-06-19T00:00:00Z"]
  );
}

function insertPendingGuardianInboxEvent(db: RunnerDatabase): void {
  db.sqlite.run(
    `insert into pi_guardian_event_inbox
     (id, event_type, project_id, idempotency_key, status, created_at, updated_at)
     values ('event-pending', 'guardian.test', 'demo', 'event-pending-key', 'pending', ?, ?)`,
    ["2026-06-19T00:00:00Z", "2026-06-19T00:00:00Z"]
  );
}

function sideEffectCounts(db: RunnerDatabase): Record<string, number> {
  return {
    conversations: countRows(db, "select count(*) as count from pi_conversations"),
    drafts: countRows(db, "select count(*) as count from im_reply_drafts"),
    intents: countRows(db, "select count(*) as count from pi_notification_intents"),
    outbox: countRows(db, "select count(*) as count from sync_outbox")
  };
}

function countRows(db: RunnerDatabase, sql: string): number {
  return db.sqlite.query<{ count: number }, []>(sql).get()?.count ?? 0;
}
