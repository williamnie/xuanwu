import { describe, expect, test } from "bun:test";
import { type RunnerDatabase } from "../../db/database.ts";
import {
  createPiNotificationIntent,
  getPiGuardianWatchdogStatus,
  listPiGuardianAlerts,
  listPiNotificationIntents,
  upsertPiGuardianWatchdogStatus
} from "../../db/repositories/pi.ts";
import { buildFeishuConnectorConfig } from "../../integrations/feishu/feishu.ts";
import { FeishuClientError } from "../../integrations/feishu/feishuClient.ts";
import { sendDirectFeishuGuardianAlert } from "../../integrations/feishu/feishuGuardianAlerts.ts";
import { runPiGuardianWatchdogOnce } from "./guardianWatchdog.ts";
import { useTestDatabase } from "../../testing/harness.ts";

export const openFixtureDatabase = useTestDatabase();

export const NOW = new Date("2026-06-19T01:00:00Z");

export const STALE_MS = 60_000;

export function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, created_at, updated_at)
     values (?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "2026-06-19T00:00:00Z", "2026-06-19T00:00:00Z"]
  );
}

export function failingProbe() {
  return {
    component: "pi_runtime" as const,
    run: () => ({
      alert_type: "pi_runtime_down",
      component: "pi_runtime" as const,
      evidence: { path: "/Users/demo/private.log", token: "fixture-token" },
      message: "PI runtime unavailable XUANWU_AUTH_TOKEN=fixture-token at /Users/demo/private.log",
      ok: false,
      project_id: "demo"
    })
  };
}

export function feishuConfig() {
  return buildFeishuConnectorConfig({
    feishuAllowedChatIds: "oc_guardian",
    feishuAppId: "cli_app_id",
    feishuAppSecret: "app-secret-value",
    feishuProjectMappings: "chat:oc_guardian=demo"
  });
}

export function guardianDelivery(db: RunnerDatabase, sender: FakeGuardianFeishuSender) {
  return {
    connectorID: "feishu",
    send: (alert: Parameters<typeof sendDirectFeishuGuardianAlert>[1], options: {
      formatText?: (value: Parameters<typeof sendDirectFeishuGuardianAlert>[1]) => string;
      now?: Date;
    } = {}) => sendDirectFeishuGuardianAlert(db, alert, {
      config: feishuConfig(),
      formatText: options.formatText,
      now: options.now,
      sender
    })
  };
}

export class FakeGuardianFeishuSender {
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

export function insertProjectPiSettings(db: RunnerDatabase, projectID: string): void {
  db.sqlite.run(
    `insert into project_pi_settings (project_id, created_at, updated_at) values (?, ?, ?)`,
    [projectID, "2026-06-19T00:00:00Z", "2026-06-19T00:00:00Z"]
  );
}

export function insertStuckOutbox(db: RunnerDatabase, createdAt: string): void {
  db.sqlite.run(
    `insert into sync_outbox (source, reply_draft_id, content, status, created_at, updated_at)
     values ('feishu', 101, 'stuck message', 'pending', ?, ?)`,
    [createdAt, createdAt]
  );
}

export function insertSuppressedStuckOutbox(db: RunnerDatabase, createdAt: string): void {
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

export function insertStaleNotificationIntent(db: RunnerDatabase): void {
  db.sqlite.run(
    `insert into pi_notification_intents
     (id, idempotency_key, project_id, target_channel, kind, state, created_at, updated_at)
     values ('intent-stale', 'intent-stale-key', 'demo', 'feishu', 'issue_done', 'ready', ?, ?)`,
    ["2026-06-19T00:00:00Z", "2026-06-19T00:00:00Z"]
  );
}

export function insertUnroutableLifecycleIntent(db: RunnerDatabase, id: string, issueID: number, kind: string): void {
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

export function insertOverdueRunGroup(db: RunnerDatabase): void {
  db.sqlite.run(
    `insert into pi_run_groups
     (id, project_id, status, deadline_at, created_at, updated_at)
     values ('group-overdue', 'demo', 'active', ?, ?, ?)`,
    ["2026-06-19T00:10:00Z", "2026-06-19T00:00:00Z", "2026-06-19T00:00:00Z"]
  );
}

export function insertFailedApprovalResolver(db: RunnerDatabase): void {
  db.sqlite.run(
    `insert into pi_approval_requests
     (approval_id, project_id, resolver_status, created_at, updated_at)
     values ('approval-failed', 'demo', 'resolve_failed', ?, ?)`,
    ["2026-06-19T00:00:00Z", "2026-06-19T00:00:00Z"]
  );
}

export function insertPendingGuardianInboxEvent(db: RunnerDatabase): void {
  db.sqlite.run(
    `insert into pi_guardian_event_inbox
     (id, event_type, project_id, idempotency_key, status, created_at, updated_at)
     values ('event-pending', 'guardian.test', 'demo', 'event-pending-key', 'pending', ?, ?)`,
    ["2026-06-19T00:00:00Z", "2026-06-19T00:00:00Z"]
  );
}

export function markAlertStatus(db: RunnerDatabase, id: string, status: string): void {
  db.sqlite.run("update pi_guardian_alerts set status=?, updated_at=? where id=?", [
    status, "2026-06-19T01:01:00Z", id
  ]);
}

export function sideEffectCounts(db: RunnerDatabase): Record<string, number> {
  return {
    conversations: countRows(db, "select count(*) as count from pi_conversations"),
    drafts: countRows(db, "select count(*) as count from im_reply_drafts"),
    intents: countRows(db, "select count(*) as count from pi_notification_intents"),
    outbox: countRows(db, "select count(*) as count from sync_outbox")
  };
}

export function countRows(db: RunnerDatabase, sql: string): number {
  return db.sqlite.query<{ count: number }, []>(sql).get()?.count ?? 0;
}
