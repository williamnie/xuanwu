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
import { createPiAction, getPiAction } from "../db/repositories/pi.ts";
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

  test("dispatches flattened project selection actions from the long-connection SDK", async () => {
    const { database, factory, messages } = await receiverFixture();
    const actions: unknown[] = [];
    const manager = createFeishuReceiverManager({
      agentBridge: {
        handle: async () => ({ reason: "unused", replied: false }),
        handleProjectSelectionAction: async (action: unknown) => {
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

function insertProject(database: RunnerDatabase): void {
  database.sqlite.run(
    `insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["demo", "Demo", "/tmp/demo", "codex", '{"capabilities":["issue_execution"]}', 1,
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}
