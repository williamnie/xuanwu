import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listExternalEvents } from "../db/repositories/externalEvents.ts";
import { assertConnectorConformance } from "./channelConnectorContracts.ts";
import { buildFeishuConnectorConfig } from "./feishu.ts";
import { ingestFeishuMessageEvent } from "./feishuIngest.ts";
import { routeFeishuConversation } from "./feishuConversationRouting.ts";
import {
  createFeishuChannelConnector,
  createFeishuOutboundEnvelope,
  migrateLegacyFeishuOutboxEnvelope,
  normalizeFeishuInboundEnvelope
} from "./feishuChannelConnector.ts";

const roots: string[] = [];
const NOW = new Date("2026-07-18T01:00:00.000Z");

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("P09.02 Feishu ChannelConnector migration", () => {
  test("normalizes, deduplicates, preserves explicit envelope hints without inferring message intent, and reuses conversation routing", async () => {
    const db = await fixtureDatabase();
    try {
      const config = configFixture();
      const raw = messageFixture();
      const normalized = normalizeFeishuInboundEnvelope(raw, {
        projectId: "demo",
        rawPayloadRef: "sha256:fixture"
      });
      expect(normalized.envelope).toMatchObject({
        connector_id: "feishu",
        cursor: { position: "om_fixture", scope: "chat:oc_fixture" },
        event_id: "feishu:message:om_fixture",
        event_type: "message.receive",
        payload: { project_hint: "demo" }
      });

      const first = ingestFeishuMessageEvent(raw, { config, database: db }, { transport: "websocket" });
      const duplicate = ingestFeishuMessageEvent(raw, { config, database: db }, { transport: "websocket" });
      const events = listExternalEvents(db, { source: "feishu" });
      expect(duplicate.event_id).toBe(first.event_id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ project_hint: "", project_id: "", trust_level: "untrusted" });

      const firstRoute = routeFeishuConversation(db, {
        clock: { now: () => NOW }, event: normalized.event, prompt: normalized.event.text
      });
      const replayRoute = routeFeishuConversation(db, {
        clock: { now: () => NOW }, event: normalized.event, prompt: normalized.event.text
      });
      expect(replayRoute.conversationId).toBe(firstRoute.conversationId);
    } finally {
      db.close();
    }
  });

  test("delivers text, cards, and reactions only through declared deterministic gates", async () => {
    const calls: Array<{ kind: string; value: unknown }> = [];
    const connector = createFeishuChannelConnector({
      config: configFixture(),
      onInbound: (envelope) => { calls.push({ kind: "inbound", value: envelope.event_id }); },
      sender: {
        addMessageReaction: async (input) => {
          calls.push({ kind: "reaction", value: input });
          return { reactionId: "reaction_fixture" };
        },
        sendInteractiveCard: async (input) => {
          calls.push({ kind: "card", value: input });
          return { messageId: "om_card" };
        },
        sendTextMessage: async (input) => {
          calls.push({ kind: "text", value: input });
          return { messageId: "om_text" };
        }
      }
    });
    assertConnectorConformance(connector);
    await connector.ingest!(normalizeFeishuInboundEnvelope(messageFixture()).envelope);

    const text = outbound("message.reply", { text: "done" });
    const card = outbound("card.send", { card: { elements: [] } });
    const reaction = outbound("reaction.add", { emoji_type: "OK", message_id: "om_fixture" });
    expect(await connector.deliver!(text)).toMatchObject({ provider_request_ref: "om_text", replayed: false });
    expect(await connector.deliver!(card)).toMatchObject({ provider_request_ref: "om_card" });
    expect(await connector.deliver!(reaction)).toMatchObject({ provider_request_ref: "reaction_fixture" });

    const untrusted = {
      ...text,
      authorization: { action_gate_ref: "llm:1", authority: "llm", decision: "allow" }
    } as unknown as typeof text;
    expect(connector.deliver!(untrusted)).rejects.toThrow("outbound.authorization.authority is not trusted");
    expect(calls.map((item) => item.kind)).toEqual(["inbound", "text", "card", "reaction"]);
  });

  test("maps the legacy approved outbox without a second writer and fails closed on target permissions", async () => {
    const envelope = migrateLegacyFeishuOutboxEnvelope({
      content: "approved reply",
      externalEventID: 12,
      id: 42,
      issueID: 7,
      occurredAt: NOW.toISOString(),
      receiveID: "oc_fixture",
      receiveIDType: "chat_id",
      replyDraftID: 41
    });
    expect(envelope).toMatchObject({
      audit: { event_ref: "sync_outbox:42", idempotency_key: "sync_outbox:42" },
      authorization: {
        action_gate_ref: "im_reply_drafts:41:approved",
        authority: "deterministic_policy",
        decision: "allow"
      },
      operation: "message.reply"
    });

    const connector = createFeishuChannelConnector({
      config: buildFeishuConnectorConfig({
        FEISHU_ALLOWED_CHAT_IDS: "oc_other",
        FEISHU_APP_ID: "cli_old_app",
        FEISHU_APP_SECRET: "cli_old_secret"
      }),
      sender: { sendTextMessage: async () => ({ messageId: "must-not-send" }) }
    });
    expect(connector.deliver!(envelope)).rejects.toThrow("target is not allowed");
  });
});

function outbound(
  operation: "card.send" | "message.reply" | "reaction.add",
  payload: Record<string, unknown>
) {
  return createFeishuOutboundEnvelope({
    actionGateRef: "im_reply_drafts:1:approved",
    actionID: "sync_outbox:1",
    authority: "deterministic_policy",
    correlationID: "external_events:1",
    eventRef: "sync_outbox:1",
    idempotencyKey: `sync_outbox:1:${operation}`,
    occurredAt: NOW.toISOString(),
    operation,
    payload,
    receiveID: "oc_fixture",
    receiveIDType: "chat_id"
  });
}

function configFixture() {
  return buildFeishuConnectorConfig({
    allowedChatIds: ["oc_fixture"],
    allowedUserIds: ["ou_fixture"],
    appId: "app_fixture",
    appSecret: "secret_fixture",
    projectMappings: [{ chatId: "oc_fixture", projectId: "demo" }]
  });
}

function messageFixture() {
  return {
    event: {
      message: {
        chat_id: "oc_fixture",
        chat_type: "group",
        content: JSON.stringify({ text: "请处理 demo" }),
        create_time: "1784336400000",
        message_id: "om_fixture"
      },
      sender: {
        sender_id: { open_id: "ou_fixture", user_id: "user_fixture" },
        sender_type: "user",
        tenant_key: "tenant_fixture"
      }
    }
  };
}

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-feishu-connector-"));
  roots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["demo", "Demo", join(root, "project"), "codex", '{"capabilities":["issue_execution"]}', 1,
      NOW.toISOString(), NOW.toISOString()]
  );
  return db;
}
