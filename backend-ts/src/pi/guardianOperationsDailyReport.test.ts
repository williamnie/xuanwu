import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import {
  createPiNotificationIntent,
  createPiNotificationPreference,
  listPiNotificationIntents,
  listPiReportRecords,
  recordPiRecoveryAttempt,
  resolvePiGuardianAlert,
  upsertPiGuardianAlert,
  upsertProjectPiPolicy
} from "../db/repositories/pi.ts";
import {
  formatGuardianOperationsDailyReport,
  guardianOperationsSnapshot,
  queueGuardianOperationsDailyReports
} from "./guardianOperationsDailyReport.ts";

const NOW = new Date("2026-07-21T01:05:00Z");
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
});

describe("PI Guardian operations daily report", () => {
  test("summarizes alerts, automatic recoveries, session recoveries, and issue retries", async () => {
    const db = await fixtureDatabase();
    try {
      const recovered = upsertPiGuardianAlert(db, {
        alert_type: "outbox_stalled", id: "alert-recovered", message: "outbox stalled", project_id: "demo"
      });
      resolvePiGuardianAlert(db, recovered.id, { message: "outbox recovered" });
      upsertPiGuardianAlert(db, {
        alert_type: "outbox_stalled", id: "alert-auto", message: "outbox stalled", project_id: "demo"
      });
      upsertPiGuardianAlert(db, {
        alert_type: "approval_fast_path_error", id: "alert-user", message: "approval stalled", project_id: "demo"
      });
      db.sqlite.run("update pi_guardian_alerts set created_at='2026-07-20T12:00:00Z', updated_at='2026-07-20T12:05:00Z', watchdog_seen_at='2026-07-20T12:05:00Z' where id='alert-recovered'");
      db.sqlite.run("update pi_guardian_alerts set created_at='2026-07-21T01:00:00Z', updated_at='2026-07-21T01:00:00Z', watchdog_seen_at='2026-07-21T01:00:00Z' where id in ('alert-auto','alert-user')");
      insertRecovery(db, "session-recovery", "session.resume_followup", 701);
      insertRecovery(db, "issue-retry", "issue.retry", 702);

      const snapshot = guardianOperationsSnapshot(db, { now: NOW, projectID: "demo" });

      expect(snapshot.summary).toEqual({
        active_pi_handling: 1,
        active_user_action_required: 1,
        alerts_detected: 3,
        alerts_recovered: 1,
        issue_retries_recovered: 1,
        session_recoveries: 1
      });
      const text = formatGuardianOperationsDailyReport(snapshot, "2026-07-21");
      expect(text).toContain("已自动恢复 1 个");
      expect(text).toContain("恢复会话 1 个");
      expect(text).toContain("仍有 1 项需要你处理");
    } finally {
      db.close();
    }
  });

  test("queues one idempotent 09:00 report through the unified notification authority", async () => {
    const db = await fixtureDatabase();
    try {
      const first = queueGuardianOperationsDailyReports(db, { now: NOW });
      const second = queueGuardianOperationsDailyReports(db, { now: new Date("2026-07-21T01:06:00Z") });
      const reports = listPiReportRecords(db, { projectId: "demo", type: "daily_operations_digest" });
      const intents = listPiNotificationIntents(db, { kind: "daily_operations_digest", projectId: "demo" });

      expect(first).toMatchObject({ generated: 1, queued: 1, scanned: 1 });
      expect(second).toMatchObject({ generated: 0, queued: 0, skipped: 1 });
      expect(reports).toHaveLength(1);
      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject({ state: "agent_pending", target_channel: "feishu", target_chat_id: "oc_demo" });
      expect(intents[0]?.payload_json).toContain("PI 运维日报");
    } finally {
      db.close();
    }
  });

  test("does not infer an operations report subscription from historical delivery routes", async () => {
    const db = await fixtureDatabase({ operationsDailyReport: false });
    try {
      const result = queueGuardianOperationsDailyReports(db, { now: NOW });

      expect(result).toMatchObject({ generated: 0, queued: 0, scanned: 0 });
      expect(listPiReportRecords(db, { projectId: "demo", type: "daily_operations_digest" })).toHaveLength(0);
      expect(listPiNotificationIntents(db, { kind: "daily_operations_digest", projectId: "demo" })).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

async function fixtureDatabase(options: { operationsDailyReport?: boolean } = {}): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "guardian-operations-report-"));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(`insert into projects (id, name, cwd, created_at, updated_at)
    values ('demo','Demo','/tmp/demo','2026-07-20T00:00:00Z','2026-07-20T00:00:00Z')`);
  upsertProjectPiPolicy(db, { project_id: "demo", timezone: "Asia/Shanghai" });
  createPiNotificationPreference(db, {
    digest_policy_json: {
      channels: ["feishu"],
      daily_at: "09:00",
      operations_daily_report: options.operationsDailyReport ?? true
    },
    id: "pref-demo-operations",
    mode: "normal",
    project_id: "demo",
    scope: "project"
  });
  createPiNotificationIntent(db, {
    decision: "send_now",
    id: "route-fixture",
    idempotency_key: "route-fixture",
    kind: "route_fixture",
    preference_id: "pref-demo-operations",
    project_id: "demo",
    state: "sent",
    summary: "route fixture",
    target_channel: "feishu",
    target_chat_id: "oc_demo"
  });
  return db;
}

function insertRecovery(db: RunnerDatabase, id: string, actionType: string, issueID: number): void {
  recordPiRecoveryAttempt(db, {
    action_type: actionType,
    budget_window_started_at: "2026-07-20T00:00:00Z",
    created_at: "2026-07-20T13:00:00Z",
    diagnosis_code: "session_no_recent_progress",
    id,
    idempotency_key: id,
    issue_id: issueID,
    project_id: "demo",
    status: "progress",
    updated_at: "2026-07-20T13:05:00Z"
  });
}
