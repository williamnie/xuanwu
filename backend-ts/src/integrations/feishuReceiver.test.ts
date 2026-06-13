import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFeishuConnectorConfig } from "./feishu.ts";
import { createFeishuReceiverManager, type FeishuWsFactory } from "./feishuReceiver.ts";
import { listExternalEvents } from "../db/repositories/externalEvents.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { EventBus } from "../events/bus.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Feishu WebSocket receiver", () => {
  test("starts long-connection mode without a public callback URL or verification token", async () => {
    const { database, factory, messages } = await receiverFixture();
    const bus = new EventBus();
    const manager = createFeishuReceiverManager({ bus, database, wsFactory: factory });
    const config = buildFeishuConnectorConfig({
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value",
      FEISHU_PROJECT_MAPPINGS: "chat:oc_group=demo"
    });

    await manager.restart(config);
    await messages.emit(messageEvent("@PI hello from ws"));

    const events = listExternalEvents(database, { source: "feishu" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      content: "@PI hello from ws",
      dedupe_key: "feishu:message:om_ws_1",
      project_id: "demo",
      source: "feishu"
    });
    expect(factory.starts).toBe(1);
    expect(manager.status()).toMatchObject({
      connected: true,
      receive_mode: "websocket",
      state: "connected"
    });
    database.close();
  });

  test("does not start a WebSocket client when callback mode is selected", async () => {
    const { database, factory } = await receiverFixture();
    const manager = createFeishuReceiverManager({ database, wsFactory: factory });
    const config = buildFeishuConnectorConfig({
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value",
      FEISHU_RECEIVE_MODE: "callback",
      FEISHU_VERIFICATION_TOKEN: "verify-token"
    });

    await manager.restart(config);

    expect(factory.starts).toBe(0);
    expect(manager.status()).toMatchObject({
      connected: false,
      receive_mode: "callback",
      state: "disabled"
    });
    database.close();
  });
});

async function receiverFixture(): Promise<{
  database: RunnerDatabase;
  factory: FeishuWsFactory & { starts: number };
  messages: { emit(event: unknown): Promise<void> };
}> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-ws-"));
  tempRoots.push(root);
  const database = await openDatabase({ stateDir: join(root, "state") });
  const messages = { emit: async (_event: unknown) => undefined as void };
  const factory = Object.assign(((input) => {
    messages.emit = input.onMessage;
    return {
      close: () => undefined,
      start: async () => {
        factory.starts += 1;
        input.onReady();
      },
      status: () => ({ state: "connected" as const, reconnectAttempts: 0 })
    };
  }) satisfies FeishuWsFactory, { starts: 0 });
  return { database, factory, messages };
}

function messageEvent(text: string): Record<string, unknown> {
  return {
    message: {
      chat_id: "oc_group",
      chat_type: "group",
      content: JSON.stringify({ text }),
      create_time: "1781244167890",
      message_id: "om_ws_1"
    },
    sender: {
      sender_id: { open_id: "ou_open_1", user_id: "ou_user_1" },
      sender_type: "user",
      tenant_key: "tenant_a"
    }
  };
}
