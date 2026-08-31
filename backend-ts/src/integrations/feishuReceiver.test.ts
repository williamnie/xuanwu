import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFeishuConnectorConfig } from "./feishu.ts";
import { createFeishuReceiverManager, type FeishuWsFactory } from "./feishuReceiver.ts";
import { listExternalEvents } from "../db/repositories/externalEvents.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { createImInteractionBinding } from "../db/repositories/imInteractionBindings.ts";
import { createPiAction, getPiAction } from "../db/repositories/pi.ts";
import { createFeishuPendingProjectSelection } from "../db/repositories/feishuProjectSelection.ts";
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
    const database = await openDatabase({ stateDir: join(root, "state") });
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

  test("resolves PI action card actions from long connection callbacks", async () => {
    const { database, factory, messages } = await receiverFixture();
    insertProject(database);
    const issue = createIssue(database, { project_id: "demo", status: "triage", title: "PI action target" });
    createPiAction(database, {
      action_type: "issue.comment",
      gate_decision: "ask",
      id: "pi-action-ws-1",
      issue_id: issue.id,
      payload_json: JSON.stringify({ body: "Approved from websocket", issue_id: issue.id }),
      project_id: "demo",
      requires_confirmation: 1,
      risk_level: "medium",
      status: "pending"
    });
    const manager = createFeishuReceiverManager({ database, wsFactory: factory });
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_ALLOWED_USER_IDS: "ou_user_1",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });

    await manager.restart(config);
    const response = await messages.emit(piActionCardEvent("pi-action-ws-1", "approve"));

    expect(response).toMatchObject({ ok: true, status: "completed" });
    expect(getPiAction(database, "pi-action-ws-1")).toMatchObject({
      approved_by: "feishu:ou_user_1",
      status: "completed"
    });
    expect(listIssueEvents(database, issue.id).map((event) => event.type)).toContain("issue.comment");
    database.close();
  });

  test("resolves flattened opaque PI action callbacks from the long-connection SDK", async () => {
    const { database, factory, messages } = await receiverFixture();
    insertProject(database);
    const issue = createIssue(database, { project_id: "demo", status: "triage", title: "Opaque PI action target" });
    createPiAction(database, {
      action_type: "issue.comment",
      gate_decision: "ask",
      id: "pi-action-ws-opaque",
      issue_id: issue.id,
      payload_json: JSON.stringify({ body: "Approved from flattened callback", issue_id: issue.id }),
      project_id: "demo",
      requires_confirmation: 1,
      risk_level: "medium",
      status: "pending"
    });
    const binding = createImInteractionBinding(database, {
      actionKind: "pi_action",
      actionRef: "pi_actions:pi-action-ws-opaque",
      actions: [{ action_id: "approve", value: "approve" }],
      actor: { id: "ou_user_1", openId: "ou_open_1" },
      connectorId: "feishu",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      scopeKey: "oc_group"
    });
    const manager = createFeishuReceiverManager({ database, wsFactory: factory });
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_ALLOWED_USER_IDS: "ou_user_1",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });

    await manager.restart(config);
    const response = await messages.emit(opaqueInteractionEvent(binding.interaction_id, "approve"));

    expect(response).toMatchObject({
      reason: "consumed",
      resolution: { ok: true, status: "completed" }
    });
    expect(getPiAction(database, "pi-action-ws-opaque")).toMatchObject({
      approved_by: "feishu:ou_user_1",
      status: "completed"
    });
    expect(listIssueEvents(database, issue.id).map((event) => event.type)).toContain("issue.comment");
    database.close();
  });
});

async function receiverFixture(): Promise<{
  database: RunnerDatabase;
  factory: FeishuWsFactory & { starts: number };
  messages: { emit(event: unknown): Promise<unknown> };
}> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-feishu-ws-"));
  tempRoots.push(root);
  const database = await openDatabase({ stateDir: join(root, "state") });
  const messages = { emit: async (_event: unknown) => undefined as unknown };
  const factory = Object.assign(((input) => {
    messages.emit = (event: unknown) => isCardAction(event) ? input.onCardAction(event) : input.onMessage(event);
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

function isCardAction(event: unknown): boolean {
  const root = event && typeof event === "object" && !Array.isArray(event) ? event as Record<string, unknown> : {};
  const header = root.header && typeof root.header === "object" && !Array.isArray(root.header)
    ? root.header as Record<string, unknown>
    : {};
  return header.event_type === "card.action.trigger" || root.event_type === "card.action.trigger";
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition timed out");
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

function projectSelectionActionEvent(): Record<string, unknown> {
  return {
    action: {
      value: {
        action: "feishu_project_select",
        project_id: "demo",
        selection_id: "fps_ws_1"
      }
    },
    context: {
      open_chat_id: "oc_group",
      open_message_id: "om_card_ws_1"
    },
    event_id: "evt_card_ws_1",
    event_type: "card.action.trigger",
    operator: {
      operator_id: {
        open_id: "ou_open_1",
        user_id: "ou_user_1"
      }
    },
    schema: "2.0"
  };
}

function piActionCardEvent(actionID: string, decision: string): Record<string, unknown> {
  return {
    event: {
      action: {
        value: {
          action: "pi_action_resolve",
          decision,
          pi_action_id: actionID
        }
      },
      context: {
        open_chat_id: "oc_group",
        open_message_id: "om_pi_action_ws_1"
      },
      operator: {
        operator_id: {
          open_id: "ou_open_1",
          user_id: "ou_user_1"
        }
      }
    },
    header: {
      event_id: "evt_pi_action_ws_1",
      event_type: "card.action.trigger"
    },
    schema: "2.0"
  };
}

function opaqueInteractionEvent(interactionID: string, actionID: string): Record<string, unknown> {
  return {
    action: {
      value: {
        action: "xuanwu_im_interaction",
        action_id: actionID,
        interaction_id: interactionID,
        revision: 1
      }
    },
    context: {
      open_chat_id: "oc_group",
      open_message_id: "om_pi_action_ws_opaque"
    },
    event_id: "evt_pi_action_ws_opaque",
    event_type: "card.action.trigger",
    operator: {
      operator_id: {
        open_id: "ou_open_1",
        user_id: "ou_user_1"
      }
    },
    schema: "2.0"
  };
}

function insertProject(database: RunnerDatabase): void {
  database.sqlite.run(
    `insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["demo", "Demo", "/tmp/demo", "codex", '{"capabilities":["issue_execution"]}', 1,
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}
