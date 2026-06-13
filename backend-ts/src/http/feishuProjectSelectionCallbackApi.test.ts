import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../config/env.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import type { createFeishuAgentBridge } from "../integrations/feishuAgentBridge.ts";
import { createDefaultRouter, createRequestHandler } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Feishu project selection callback endpoint", () => {
  test("passes project selection card callbacks to the Feishu agent bridge", async () => {
    const actions: unknown[] = [];
    const bridge = bridgeFixture(actions);
    const { database, handle } = await fixtureHandler(bridge);
    try {
      const response = await postFeishu(handle, projectSelectionCallback());

      expect(response.status).toBe(202);
      expect(actions).toEqual([{
        action_id: "event-card-1",
        chat_id: "oc_group",
        message_id: "om_card_1",
        project_id: "demo",
        selection_id: "fps_1",
        user_id: "ou_user_1",
        user_open_id: "ou_open_1"
      }]);
    } finally {
      database.close();
    }
  });
});

async function fixtureHandler(agentBridge: ReturnType<typeof createFeishuAgentBridge>) {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-card-callback-"));
  tempRoots.push(root);
  const database = await openDatabase({ stateDir: join(root, "state") });
  const config = buildConfig({
    feishuAppId: "cli_app_id",
    feishuAppSecret: "app-secret-value",
    feishuVerificationToken: "verify-token"
  });
  const router = createDefaultRouter({ config, database, feishuAgentBridge: agentBridge });
  return { database, handle: createRequestHandler(router, "") };
}

function bridgeFixture(actions: unknown[]): ReturnType<typeof createFeishuAgentBridge> {
  return {
    handle: async () => ({ reason: "unused", replied: false }),
    handleProjectSelectionAction: async (action: unknown) => {
      actions.push(action);
      return { reason: "project_selection_continued", replied: true };
    }
  } as ReturnType<typeof createFeishuAgentBridge>;
}

async function postFeishu(handle: (request: Request) => Promise<Response>, body: unknown): Promise<Response> {
  return handle(new Request(`${BASE_URL}/api/integrations/feishu/events`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  }));
}

function projectSelectionCallback(): Record<string, unknown> {
  return {
    header: {
      event_id: "event-card-1",
      event_type: "card.action.trigger",
      token: "verify-token"
    },
    event: {
      action: {
        value: {
          action: "feishu_project_select",
          project_id: "demo",
          selection_id: "fps_1"
        }
      },
      context: {
        open_chat_id: "oc_group",
        open_message_id: "om_card_1"
      },
      operator: {
        operator_id: {
          open_id: "ou_open_1",
          user_id: "ou_user_1"
        }
      }
    },
    schema: "2.0"
  };
}
