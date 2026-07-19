import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listSyncOutbox } from "../db/repositories/imReplyOutbox.ts";
import {
  createPiNotificationIntent,
  createPiRunGroup,
  getPiNotificationIntent
} from "../db/repositories/pi.ts";
import { flushAgentCommunicationTestMessages } from "../notifications/agentCommunicationGateway.testSupport.ts";
import { queueReadyFeishuDigestNotifications } from "./feishuLifecycleNotifications.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Feishu run group digest notifications", () => {
  test("queues a redacted digest summary through the existing outbox", async () => {
    const db = await fixtureDatabase();
    try {
      seedProject(db);
      createPiRunGroup(db, {
        id: "group-digest",
        origin_conversation_id: "feishu-chat-oc_group-20260618",
        project_id: "demo",
        expected_issue_count: 6
      });
      const intent = createPiNotificationIntent(db, {
        flush_reason: "completed",
        flush_sequence: 1,
        kind: "digest",
        payload_json: digestPayload(),
        project_id: "demo",
        run_group_id: "group-digest",
        state: "ready",
        target_channel: "feishu"
      });

      const result = queueReadyFeishuDigestNotifications(db);
      await flushAgentCommunicationTestMessages(db);
      const outbox = listSyncOutbox(db, { source: "feishu" });
      const sent = getPiNotificationIntent(db, intent.id);
      const content = outbox[0]?.content ?? "";

      expect(result).toMatchObject({ failed: 0, queued: 1, scanned: 1, skipped: 0 });
      expect(outbox).toHaveLength(1);
      expect(sent).toMatchObject({ sent_outbox_id: outbox[0]?.id, state: "sent" });
      expect(sent?.sent_at).not.toBe("");
      expect(content).toContain("总数：6");
      expect(content).toContain("完成：1");
      expect(content).toContain("待验证：1");
      expect(content).toContain("失败：1");
      expect(content).toContain("需要用户：1");
      expect(content).toContain("仍在跑：1");
      expect(content).toContain("跳过：1");
      expect(content).toContain("issue #103");
      expect(content).toContain("issue #104");
      expect(content).toContain("enqueue_failed");
      expect(content).toContain("enqueue_pending_approval");
      expect(content).toContain("skipped");
      expect(content).not.toContain("fixture-secret");
      expect(content).not.toContain("/Users/example");
      expect(content).not.toContain("at run");
    } finally {
      db.close();
    }
  });

  test("keeps missing-target digest intents retryable without copying payload details", async () => {
    const db = await fixtureDatabase();
    try {
      seedProject(db);
      createPiRunGroup(db, { id: "group-no-target", project_id: "demo", expected_issue_count: 1 });
      const intent = createPiNotificationIntent(db, {
        flush_reason: "completed",
        flush_sequence: 1,
        kind: "digest",
        payload_json: {
          issues: [{ issue_id: 201, reason: "TOKEN=fixture-secret at /Users/example/secret.ts" }],
          total_count: 1
        },
        project_id: "demo",
        run_group_id: "group-no-target",
        state: "ready",
        target_channel: "feishu"
      });

      const result = queueReadyFeishuDigestNotifications(db);
      const stored = getPiNotificationIntent(db, intent.id);

      expect(result).toMatchObject({ failed: 1, queued: 0, scanned: 1, skipped: 0 });
      expect(listSyncOutbox(db, { source: "feishu" })).toHaveLength(0);
      expect(stored).toMatchObject({ sent_outbox_id: 0, state: "ready" });
      expect(stored?.error).toContain("missing_feishu_target");
      expect(stored?.error).not.toContain("fixture-secret");
      expect(stored?.error).not.toContain("/Users/example");
    } finally {
      db.close();
    }
  });
});

function digestPayload() {
  return {
    active_count: 1,
    completed_count: 1,
    failed_count: 1,
    issues: [
      { bucket: "failed", issue_id: 103, reason: "Error: TOKEN=fixture-secret at /Users/example/app.ts\n    at run (/Users/example/app.ts:1:1)", status: "failed" },
      { bucket: "needs_user", issue_id: 104, reason: "Authorization: Bearer fixture-secret", status: "enqueue_pending_approval" },
      { bucket: "skipped", issue_id: 105, reason: "enqueue rejected at /Users/example/private.ts", status: "enqueue_failed" },
      { bucket: "skipped", issue_id: 106, reason: "user skipped", status: "skipped" }
    ],
    needs_user_count: 1,
    run_group_id: "group-digest",
    skipped_count: 1,
    total_count: 6,
    verification_count: 1
  };
}

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-digest-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function seedProject(db: RunnerDatabase): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["demo", "Demo", "/tmp/demo", "codex", '{"capabilities":["issue_execution"]}', 1,
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}
