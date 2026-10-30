import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFeishuConnectorConfig } from "./feishu.ts";
import { createFeishuReceiverManager, type FeishuWsFactory } from "./feishuReceiver.ts";
import { listExternalEvents } from "../../db/repositories/externalEvents.ts";
import { openDatabase } from "../../db/database.ts";
import { createFeishuPendingProjectSelection } from "../../db/repositories/feishuProjectSelection.ts";
import { EventBus } from "../../events/bus.ts";
import type { TestFixture } from "./feishuReceiver.testFixture.ts";

export function registerStartsLongConnectionModeWithoutCases(testScope: TestFixture) {
  const { trackDatabase, tempRoots, receiverFixture, waitFor, messageEvent, projectSelectionActionEvent } = testScope;
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
        project_id: "",
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
  
  test("recreates the WebSocket client with bounded backoff when startup rejects", async () => {
      const { database } = await receiverFixture();
      let clients = 0;
      const manager = createFeishuReceiverManager({
        database,
        retryBaseMs: 0,
        wsFactory: async (input) => {
          clients += 1;
          const attempt = clients;
          return {
            close: () => undefined,
            start: async () => {
              if (attempt === 1) throw new Error("timeout of 15000ms exceeded");
              input.onReady();
            }
          };
        }
      });
      const config = buildFeishuConnectorConfig({
        FEISHU_APP_ID: "cli_app_id",
        FEISHU_APP_SECRET: "app-secret-value"
      });
  
      await manager.restart(config);
      await waitFor(() => manager.status().connected);
  
      expect(clients).toBe(2);
      expect(manager.status()).toMatchObject({
        connected: true,
        last_error: "",
        reconnect_attempts: 1,
        state: "connected"
      });
      manager.stop();
      database.close();
    });
  
  test("ignores message, card and health callbacks from a stopped receiver generation", async () => {
      const root = await mkdtemp(join(tmpdir(), "xuanwu-feishu-ws-generation-"));
      tempRoots.push(root);
      const database = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
      const generations: Parameters<FeishuWsFactory>[0][] = [];
      const manager = createFeishuReceiverManager({
        database,
        wsFactory: async (input) => {
          generations.push(input);
          return { close: () => undefined, start: async () => input.onReady() };
        }
      });
      const config = buildFeishuConnectorConfig({
        FEISHU_APP_ID: "cli_app_id",
        FEISHU_APP_SECRET: "app-secret-value"
      });
  
      await manager.restart(config);
      await manager.restart(config);
      expect(generations).toHaveLength(2);
      const staleMessage = messageEvent("stale");
      (staleMessage.message as Record<string, unknown>).message_id = "om_stale_generation";
      expect(await generations[0]!.onCardAction(projectSelectionActionEvent())).toEqual({
        ok: false,
        reason: "stale_receiver_generation"
      });
      await generations[0]!.onMessage(staleMessage);
      generations[0]!.onError(new Error("stale error"));
      generations[0]!.onReconnecting();
      expect(listExternalEvents(database, { source: "feishu" })).toHaveLength(0);
      expect(manager.status()).toMatchObject({ connected: true, last_error: "", state: "connected" });
  
      const currentMessage = messageEvent("current");
      (currentMessage.message as Record<string, unknown>).message_id = "om_current_generation";
      await generations[1]!.onMessage(currentMessage);
      expect(listExternalEvents(database, { source: "feishu" }).map((event) => event.external_id))
        .toEqual(["om_current_generation"]);
      manager.stop();
      expect(manager.status()).toMatchObject({ connected: false, state: "disabled" });
      database.close();
    });
  
  test("dispatches flattened project selection actions from the long-connection SDK", async () => {
      const { database, factory, messages } = await receiverFixture();
      const actions: unknown[] = [];
      createFeishuPendingProjectSelection(database, {
        candidates: ["demo"],
        chatId: "oc_group",
        conversationId: "conversation-ws-1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        originalPrompt: "处理这个任务",
        scopeKey: "oc_group",
        selectionId: "fps_ws_1",
        sourceMessageId: "om_card_ws_1",
        userId: "ou_user_1",
        userOpenId: "ou_open_1"
      });
      const manager = createFeishuReceiverManager({
        agentBridge: {
          handle: async () => ({ reason: "unused", replied: false }),
          resolveProjectSelectionAction: async (action: unknown) => {
            actions.push(action);
            return { reason: "project_selection_continued", replied: true };
          }
        } as Parameters<typeof createFeishuReceiverManager>[0]["agentBridge"],
        database,
        wsFactory: factory
      });
      const config = buildFeishuConnectorConfig({
        FEISHU_APP_ID: "cli_app_id",
        FEISHU_APP_SECRET: "app-secret-value"
      });
  
      await manager.restart(config);
      const response = await messages.emit(projectSelectionActionEvent());
  
      expect(actions).toEqual([{
        action_id: "evt_card_ws_1",
        chat_id: "oc_group",
        message_id: "om_card_ws_1",
        project_id: "demo",
        selection_id: "fps_ws_1",
        user_id: "ou_user_1",
        user_open_id: "ou_open_1"
      }]);
      expect(response).toEqual({
        toast: {
          content: "已收到项目选择，正在继续处理。",
          type: "info"
        }
      });
      expect(manager.status()).toMatchObject({ connected: true, state: "connected" });
      database.close();
    });
}
