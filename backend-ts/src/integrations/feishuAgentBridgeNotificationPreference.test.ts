import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createPiGuardianEvent, listPiNotificationPreferences } from "../db/repositories/pi.ts";
import { buildFeishuConnectorConfig, normalizeFeishuMessageEvent } from "./feishu.ts";
import { createFeishuAgentBridge } from "./feishuAgentBridge.ts";
import type { FeishuTextMessageInput } from "./feishuClient.ts";
import { ingestFeishuMessageEvent } from "./feishuIngest.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Feishu agent bridge notification preference command", () => {
  test("writes a structured preference candidate directly before replying confirmation", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    const calls: string[] = [];
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_PROJECT_MAPPINGS: "chat:oc_group=demo",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    const anchor = createPiGuardianEvent(database, {
      id: "event-before-feishu-pref",
      event_type: "issue.done",
      idempotency_key: "issue.done:demo:902:event-before-feishu-pref",
      issue_id: 902,
      project_id: "demo",
      source: "issue_events",
      source_event_id: "issue_event:902"
    });
    const bridge = createFeishuAgentBridge({
      clock: { now: () => new Date("2026-06-18T01:00:00Z") },
      config: () => config,
      database,
      runConversation: async ({ prompt }) => {
        calls.push(prompt);
        return { text: "should not run" };
      },
      sender: { sendTextMessage: async (input) => {
        sent.push(input);
        return { messageId: "om_reply_notify_pref" };
      } }
    });

    const result = await bridge.handle(normalizeEvent(
      "/notify {\"mode\":\"quiet\",\"temporary\":true,\"ttl_minutes\":60,\"notify_on\":[\"needs_user\"]}",
      "om_notify_pref",
      config,
      database
    ));
    const preferences = listPiNotificationPreferences(database, { scope: "conversation" });

    expect(result).toEqual({ reason: "notification_preference_saved", replied: true });
    expect(calls).toEqual([]);
    expect(preferences).toMatchObject([{
      conversation_id: "feishu-chat-oc_group-20260618",
      effective_after_sequence: anchor.sequence_id,
      expires_at: "2026-06-18T02:00:00Z",
      mode: "quiet",
      project_id: "demo",
      source_message_id: "om_notify_pref"
    }]);
    expect(sent.map((item) => item.text)).toEqual([
      preferences[0]?.confirmation_text
    ]);
    database.close();
  });

  test("reports invalid preference candidates without writing rows or running PI", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    const calls: string[] = [];
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    const bridge = createFeishuAgentBridge({
      clock: { now: () => new Date("2026-06-18T01:00:00Z") },
      config: () => config,
      database,
      runConversation: async ({ prompt }) => {
        calls.push(prompt);
        return { text: "should not run" };
      },
      sender: { sendTextMessage: async (input) => {
        sent.push(input);
        return { messageId: "om_reply_notify_invalid" };
      } }
    });

    const result = await bridge.handle(normalizeEvent(
      "/notify {\"mode\":\"quiet\",\"scope\":\"conversation\",\"temporary\":true,\"ttl_minutes\":999999}",
      "om_notify_invalid",
      config,
      database
    ));

    expect(result).toEqual({ reason: "notification_preference_rejected", replied: true });
    expect(calls).toEqual([]);
    expect(listPiNotificationPreferences(database)).toEqual([]);
    expect(sent[0]?.text).toContain("通知偏好没有保存");
    database.close();
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-notify-pref-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function normalizeEvent(
  text: string,
  messageId: string,
  config: ReturnType<typeof buildFeishuConnectorConfig>,
  database: RunnerDatabase
) {
  const raw = messageEvent(text, messageId);
  return {
    event: normalizeFeishuMessageEvent(raw),
    ingest: ingestFeishuMessageEvent(raw, { config, database }, { transport: "websocket" })
  };
}

function messageEvent(text: string, messageId: string): Record<string, unknown> {
  return {
    message: {
      chat_id: "oc_group",
      chat_type: "group",
      content: JSON.stringify({ text }),
      create_time: "1781244167890",
      message_id: messageId
    },
    sender: {
      sender_id: { open_id: "ou_open_1", user_id: "ou_user_1" },
      sender_type: "user",
      tenant_key: "tenant_a"
    }
  };
}
