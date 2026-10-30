import { afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FeishuWsFactory } from "./feishuReceiver.ts";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { useDatabaseCleanup } from "../../testing/harness.ts";



export function createTestFixture() {
  const trackDatabase = useDatabaseCleanup();

  const tempRoots: string[] = [];

  afterEach(async () => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true });
    }
  });

  async function receiverFixture(): Promise<{
    database: RunnerDatabase;
    factory: FeishuWsFactory & { starts: number };
    messages: { emit(event: unknown): Promise<unknown> };
  }> {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-feishu-ws-"));
    tempRoots.push(root);
    const database = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
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
  return { trackDatabase, tempRoots, receiverFixture, isCardAction, waitFor, messageEvent, projectSelectionActionEvent, piActionCardEvent, opaqueInteractionEvent, insertProject };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
