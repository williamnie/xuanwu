import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import {
  getPiGuardianWatchdogStatus,
  listPiGuardianAlerts,
  listPiNotificationIntents,
  upsertPiGuardianWatchdogStatus
} from "../db/repositories/pi.ts";
import { buildFeishuConnectorConfig } from "../integrations/feishu.ts";
import { FeishuClientError } from "../integrations/feishuClient.ts";
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
  test("writes UI alert before direct Feishu and records sent id without pipeline side effects", async () => {
    const db = await openFixtureDatabase();
    const sender = new FakeGuardianFeishuSender([{ messageId: "om_guardian_sent_1" }], () => {
      const alert = listPiGuardianAlerts(db, { projectId: "demo", status: "open" })[0];
      expect(alert).toMatchObject({ direct_feishu_state: "not_attempted", ui_visible: 1 });
    });
    try {
      insertProject(db, "demo");

      await runPiGuardianWatchdogOnce(db, {
        checks: [failingProbe()],
        directFeishu: { config: feishuConfig(), sender },
        now: NOW,
        staleAfterMs: STALE_MS
      });
      const alerts = listPiGuardianAlerts(db, { projectId: "demo", status: "open" });

      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        direct_feishu_message_id: "om_guardian_sent_1",
        direct_feishu_state: "sent",
        next_retry_at: "2026-06-19T01:15:00Z",
        retry_count: 0,
        status: "open",
        ui_visible: 1
      });
      expect(sender.calls).toHaveLength(1);
      expect(sender.calls[0]).toMatchObject({ receiveId: "oc_guardian", receiveIdType: "chat_id" });
      expect(sender.calls[0]?.text).toContain("[玄武 Supervisor] 项目 PI Runtime 不可用");
      expect(sender.calls[0]?.text).toContain("发生了什么：项目的 PI Agent、会话或运行配置不可用");
      expect(sender.calls[0]?.text).toContain("需要你处理：检查项目的 PI Agent 是否存在并启用");
      expect(sender.calls[0]?.text).toContain("影响位置：项目 demo");
      expect(sender.calls[0]?.text).not.toContain("alert=");
      expect(sender.calls[0]?.text).not.toContain("severity=");
      expect(sender.calls[0]?.text).not.toContain("fixture-token");
      expect(sender.calls[0]?.text).not.toContain("/Users/demo");
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

  test("keeps UI alert open when direct Feishu falls back to retry", async () => {
    const db = await openFixtureDatabase();
    const sender = new FakeGuardianFeishuSender([
      new FeishuClientError("socket closed CODEX_RUNNER_AUTH_TOKEN=fixture-token at /Users/demo/private.log", {
        kind: "temporary",
        retryAfterSeconds: 30
      })
    ]);
    try {
      insertProject(db, "demo");

      await runPiGuardianWatchdogOnce(db, {
        checks: [failingProbe()],
        directFeishu: { config: feishuConfig(), sender },
        now: NOW,
        staleAfterMs: STALE_MS
      });
      const alert = listPiGuardianAlerts(db, { projectId: "demo", status: "open" })[0];

      expect(alert).toMatchObject({
        direct_feishu_state: "retry",
        max_retry_count: 3,
        next_retry_at: "2026-06-19T01:15:00Z",
        retry_count: 1,
        status: "open",
        ui_visible: 1
      });
      expect(alert.direct_feishu_error).toContain("[redacted");
      expect(alert.direct_feishu_error).not.toContain("fixture-token");
      expect(alert.direct_feishu_error).not.toContain("/Users/demo");
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

  test("backs off urgent alert retries and keeps UI visible after max cap", async () => {
    const db = await openFixtureDatabase();
    const sender = new FakeGuardianFeishuSender([
      new FeishuClientError("temporary outage 1", { kind: "temporary" }),
      new FeishuClientError("temporary outage 2", { kind: "temporary" }),
      new FeishuClientError("temporary outage 3", { kind: "temporary" })
    ]);
    try {
      insertProject(db, "demo");

      await runPiGuardianWatchdogOnce(db, {
        checks: [failingProbe()],
        directFeishu: { config: feishuConfig(), sender },
        now: NOW,
        staleAfterMs: STALE_MS
      });
      await runPiGuardianWatchdogOnce(db, {
        checks: [failingProbe()],
        directFeishu: { config: feishuConfig(), sender },
        now: new Date("2026-06-19T01:10:00Z"),
        staleAfterMs: STALE_MS
      });
      await runPiGuardianWatchdogOnce(db, {
        checks: [failingProbe()],
        directFeishu: { config: feishuConfig(), sender },
        now: new Date("2026-06-19T01:15:00Z"),
        staleAfterMs: STALE_MS
      });
      await runPiGuardianWatchdogOnce(db, {
        checks: [failingProbe()],
        directFeishu: { config: feishuConfig(), sender },
        now: new Date("2026-06-19T02:15:00Z"),
        staleAfterMs: STALE_MS
      });
      await runPiGuardianWatchdogOnce(db, {
        checks: [failingProbe()],
        directFeishu: { config: feishuConfig(), sender },
        now: new Date("2026-06-19T06:15:00Z"),
        staleAfterMs: STALE_MS
      });
      const alert = listPiGuardianAlerts(db, { projectId: "demo", status: "open" })[0];

      expect(sender.calls).toHaveLength(3);
      expect(alert).toMatchObject({
        direct_feishu_state: "failed",
        next_retry_at: "",
        retry_count: 3,
        status: "open",
        ui_visible: 1
      });
    } finally {
      db.close();
    }
  });

  test("retries unacknowledged sent urgent alerts with backoff and max cap", async () => {
    const db = await openFixtureDatabase();
    const sender = new FakeGuardianFeishuSender([
      { messageId: "om_initial" },
      { messageId: "om_retry_1" },
      { messageId: "om_retry_2" },
      { messageId: "om_retry_3" },
      { messageId: "om_unexpected" }
    ]);
    try {
      insertProject(db, "demo");

      await runPiGuardianWatchdogOnce(db, {
        checks: [failingProbe()],
        directFeishu: { config: feishuConfig(), sender },
        now: NOW,
        staleAfterMs: STALE_MS
      });
      await runPiGuardianWatchdogOnce(db, {
        checks: [failingProbe()],
        directFeishu: { config: feishuConfig(), sender },
        now: new Date("2026-06-19T01:10:00Z"),
        staleAfterMs: STALE_MS
      });
      await runPiGuardianWatchdogOnce(db, {
        checks: [failingProbe()],
        directFeishu: { config: feishuConfig(), sender },
        now: new Date("2026-06-19T01:15:00Z"),
        staleAfterMs: STALE_MS
      });
      await runPiGuardianWatchdogOnce(db, {
        checks: [failingProbe()],
        directFeishu: { config: feishuConfig(), sender },
        now: new Date("2026-06-19T02:15:00Z"),
        staleAfterMs: STALE_MS
      });
      await runPiGuardianWatchdogOnce(db, {
        checks: [failingProbe()],
        directFeishu: { config: feishuConfig(), sender },
        now: new Date("2026-06-19T06:15:00Z"),
        staleAfterMs: STALE_MS
      });
      await runPiGuardianWatchdogOnce(db, {
        checks: [failingProbe()],
        directFeishu: { config: feishuConfig(), sender },
        now: new Date("2026-06-19T10:15:00Z"),
        staleAfterMs: STALE_MS
      });
      const alert = listPiGuardianAlerts(db, { projectId: "demo", status: "open" })[0];

      expect(sender.calls).toHaveLength(4);
      expect(alert).toMatchObject({
        direct_feishu_message_id: "om_retry_3",
        direct_feishu_state: "sent",
        next_retry_at: "",
        retry_count: 3,
        status: "open",
        ui_visible: 1
      });
    } finally {
      db.close();
    }
  });

  for (const status of ["acked", "suppressed"] as const) {
    test(`does not reopen or retry ${status} alerts for the same watchdog condition`, async () => {
      const db = await openFixtureDatabase();
      const sender = new FakeGuardianFeishuSender([{ messageId: "om_guardian_sent_1" }]);
      try {
        insertProject(db, "demo");
        await runPiGuardianWatchdogOnce(db, {
          checks: [failingProbe()],
          directFeishu: { config: feishuConfig(), sender },
          now: NOW,
          staleAfterMs: STALE_MS
        });
        const firstAlert = listPiGuardianAlerts(db, { projectId: "demo", status: "open" })[0];
        if (!firstAlert) throw new Error("expected open alert");
        markAlertStatus(db, firstAlert.id, status);

        await runPiGuardianWatchdogOnce(db, {
          checks: [failingProbe()],
          directFeishu: { config: feishuConfig(), sender },
          now: new Date("2026-06-19T01:15:00Z"),
          staleAfterMs: STALE_MS
        });

        expect(sender.calls).toHaveLength(1);
        expect(listPiGuardianAlerts(db, { projectId: "demo", status: "open" })).toHaveLength(0);
        expect(listPiGuardianAlerts(db, { projectId: "demo", status })).toHaveLength(1);
      } finally {
        db.close();
      }
    });
  }


  test("creates a new incident when the same watchdog condition recurs after recovery", async () => {
    const db = await openFixtureDatabase();
    const sender = new FakeGuardianFeishuSender([
      { messageId: "om_guardian_first" },
      { messageId: "om_guardian_recurrence" }
    ]);
    try {
      insertProject(db, "demo");
      await runPiGuardianWatchdogOnce(db, {
        checks: [failingProbe()], directFeishu: { config: feishuConfig(), sender }, now: NOW, staleAfterMs: STALE_MS
      });
      const first = listPiGuardianAlerts(db, { projectId: "demo", status: "open" })[0];
      if (!first) throw new Error("expected first alert");
      markAlertStatus(db, first.id, "resolved");

      await runPiGuardianWatchdogOnce(db, {
        checks: [failingProbe()], directFeishu: { config: feishuConfig(), sender },
        now: new Date("2026-06-19T01:15:00Z"), staleAfterMs: STALE_MS
      });

      expect(sender.calls).toHaveLength(2);
      expect(listPiGuardianAlerts(db, { projectId: "demo", status: "resolved" })).toHaveLength(1);
      const recurrence = listPiGuardianAlerts(db, { projectId: "demo", status: "open" })[0];
      expect(recurrence).toMatchObject({ status: "open" });
      expect(recurrence?.id).not.toBe(first.id);
    } finally {
      db.close();
    }
  });

  test("writes PI runtime alert, refreshes liveness, and avoids PI/outbox side effects", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      insertProjectPiSettings(db, "demo");
      db.sqlite.run("update pi_agents set enabled=0 where id='runner-default'");

      const result = await runPiGuardianWatchdogOnce(db, { now: NOW, staleAfterMs: STALE_MS });
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

      const first = await runPiGuardianWatchdogOnce(db, { now: NOW, staleAfterMs: STALE_MS });
      const firstAlert = listPiGuardianAlerts(db, { alertType: "outbox_stalled", status: "open" })[0];
      const second = await runPiGuardianWatchdogOnce(db, {
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

  test("does not report an outbox row whose notification intent was suppressed", async () => {
    const db = await openFixtureDatabase();
    try {
      insertSuppressedStuckOutbox(db, "2026-06-19T00:00:00Z");

      const result = await runPiGuardianWatchdogOnce(db, { now: NOW, staleAfterMs: STALE_MS });

      expect(result.checks.find((check) => check.component === "outbox")).toMatchObject({ ok: true });
      expect(listPiGuardianAlerts(db, { alertType: "outbox_stalled", status: "open" })).toEqual([]);
      expect(sideEffectCounts(db).outbox).toBe(1);
    } finally {
      db.close();
    }
  });

  test("ignores unroutable lifecycle intents when checking coordinator stalls", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      insertUnroutableLifecycleIntent(db, "intent-start", 501, "issue_start");
      insertUnroutableLifecycleIntent(db, "intent-done", 502, "issue_done");

      const result = await runPiGuardianWatchdogOnce(db, {
        now: NOW,
        staleAfterMs: STALE_MS
      });
      const coordinator = result.checks.find((check) => check.component === "coordinator");

      expect(coordinator).toMatchObject({ ok: true });
      expect(listPiGuardianAlerts(db, { alertType: "coordinator_stalled", status: "open" })).toHaveLength(0);
      expect(listPiNotificationIntents(db, { projectId: "demo" })).toEqual(expect.arrayContaining([
        expect.objectContaining({
          decision: "suppress",
          error: "missing_feishu_link",
          id: "intent-start",
          state: "suppressed"
        }),
        expect.objectContaining({
          decision: "suppress",
          error: "missing_feishu_link",
          id: "intent-done",
          state: "suppressed"
        })
      ]));
    } finally {
      db.close();
    }
  });

  test("keeps recovered coordinator alert open for the scheduler missed-intent sweep", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      insertStaleNotificationIntent(db);
      await runPiGuardianWatchdogOnce(db, { now: NOW, staleAfterMs: STALE_MS });
      const alert = listPiGuardianAlerts(db, { alertType: "coordinator_stalled", status: "open" })[0];
      if (!alert) throw new Error("expected coordinator alert");
      db.sqlite.run("update pi_notification_intents set state='suppressed', updated_at=? where id='intent-stale'", [
        "2026-06-19T01:01:00Z"
      ]);

      const result = await runPiGuardianWatchdogOnce(db, {
        now: new Date("2026-06-19T01:05:00Z"),
        staleAfterMs: STALE_MS
      });

      expect(result.checks.find((check) => check.component === "coordinator")).toMatchObject({ ok: true });
      expect(listPiGuardianAlerts(db, { alertType: "coordinator_stalled", status: "open" })).toMatchObject([
        expect.objectContaining({
          id: alert.id,
          message: "coordinator stalled: 1 stale item(s)",
          status: "open",
          watchdog_seen_at: "2026-06-19T01:00:00Z"
        })
      ]);
      expect(listPiGuardianAlerts(db, { alertType: "coordinator_stalled", status: "resolved" })).toHaveLength(0);
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

      const result = await runPiGuardianWatchdogOnce(db, {
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
      const result = await runPiGuardianWatchdogOnce(db, {
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

function failingProbe() {
  return {
    component: "pi_runtime" as const,
    run: () => ({
      alert_type: "pi_runtime_down",
      component: "pi_runtime" as const,
      evidence: { path: "/Users/demo/private.log", token: "fixture-token" },
      message: "PI runtime unavailable CODEX_RUNNER_AUTH_TOKEN=fixture-token at /Users/demo/private.log",
      ok: false,
      project_id: "demo"
    })
  };
}

function feishuConfig() {
  return buildFeishuConnectorConfig({
    feishuAllowedChatIds: "oc_guardian",
    feishuAppId: "cli_app_id",
    feishuAppSecret: "app-secret-value",
    feishuProjectMappings: "chat:oc_guardian=demo"
  });
}

class FakeGuardianFeishuSender {
  calls: Array<{ receiveId: string; receiveIdType: string; text: string }> = [];
  constructor(
    private readonly outcomes: Array<{ messageId: string } | Error>,
    private readonly onSend: () => void = () => {}
  ) {}

  async sendTextMessage(input: { receiveId: string; receiveIdType: string; text: string }): Promise<{ messageId: string }> {
    this.calls.push(input);
    this.onSend();
    const next = this.outcomes.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("unexpected fake guardian Feishu send");
    return next;
  }
}

function insertProjectPiSettings(db: RunnerDatabase, projectID: string): void {
  db.sqlite.run(
    `insert into project_pi_settings (project_id, created_at, updated_at) values (?, ?, ?)`,
    [projectID, "2026-06-19T00:00:00Z", "2026-06-19T00:00:00Z"]
  );
}

function insertStuckOutbox(db: RunnerDatabase, createdAt: string): void {
  db.sqlite.run(
    `insert into sync_outbox (source, reply_draft_id, content, status, created_at, updated_at)
     values ('feishu', 101, 'stuck message', 'pending', ?, ?)`,
    [createdAt, createdAt]
  );
}

function insertSuppressedStuckOutbox(db: RunnerDatabase, createdAt: string): void {
  db.sqlite.run(
    `insert into sync_outbox
     (source, reply_draft_id, project_id, operation_kind, content, status, last_error, created_at, updated_at)
     values ('feishu', 101, 'demo', 'im_reply', 'suppressed historical message', 'failed',
       'historical_pending_backfill_suppressed', ?, ?)`,
    [createdAt, createdAt]
  );
  const outboxID = Number(db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0);
  db.sqlite.run(
    `insert into pi_notification_intents
     (id, idempotency_key, project_id, target_channel, kind, state, sent_outbox_id, created_at, updated_at)
     values ('intent-suppressed', 'intent-suppressed-key', 'demo', 'feishu', 'pi_action_pending',
       'suppressed', ?, ?, ?)`,
    [outboxID, createdAt, createdAt]
  );
}

function insertStaleNotificationIntent(db: RunnerDatabase): void {
  db.sqlite.run(
    `insert into pi_notification_intents
     (id, idempotency_key, project_id, target_channel, kind, state, created_at, updated_at)
     values ('intent-stale', 'intent-stale-key', 'demo', 'feishu', 'issue_done', 'ready', ?, ?)`,
    ["2026-06-19T00:00:00Z", "2026-06-19T00:00:00Z"]
  );
}

function insertUnroutableLifecycleIntent(db: RunnerDatabase, id: string, issueID: number, kind: string): void {
  db.sqlite.run(
    `insert into issues (id, project_id, title, status, created_at, updated_at)
     values (?, 'demo', ?, 'todo', ?, ?)`,
    [issueID, `Issue ${issueID}`, "2026-06-19T00:00:00Z", "2026-06-19T00:00:00Z"]
  );
  db.sqlite.run(
    `insert into pi_notification_intents
     (id, idempotency_key, project_id, issue_id, kind, state, decision, created_at, updated_at)
     values (?, ?, 'demo', ?, ?, 'ready', 'send_now', ?, ?)`,
    [id, `${id}-key`, issueID, kind, "2026-06-19T00:00:00Z", "2026-06-19T00:00:00Z"]
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

function markAlertStatus(db: RunnerDatabase, id: string, status: string): void {
  db.sqlite.run("update pi_guardian_alerts set status=?, updated_at=? where id=?", [
    status, "2026-06-19T01:01:00Z", id
  ]);
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
