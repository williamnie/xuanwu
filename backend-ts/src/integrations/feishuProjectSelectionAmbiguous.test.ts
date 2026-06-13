import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { buildFeishuConnectorConfig, normalizeFeishuMessageEvent } from "./feishu.ts";
import { createFeishuAgentBridge } from "./feishuAgentBridge.ts";
import { ingestFeishuMessageEvent } from "./feishuIngest.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Feishu ambiguous project selection", () => {
  test("asks project selection when explicit project text is ambiguous", async () => {
    const database = await openFixtureDatabase();
    const sentCards: Record<string, unknown>[] = [];
    const calls: string[] = [];
    const config = configFixture();
    insertProject(database, "runner-api", "Runner API");
    insertProject(database, "runner-web", "Runner Web");
    const bridge = createFeishuAgentBridge({
      clock: fixedClock(),
      config: () => config,
      database,
      runConversation: async ({ prompt }) => {
        calls.push(prompt);
        return { text: "should not run" };
      },
      sender: {
        sendInteractiveCard: async (input) => {
          sentCards.push(input.card);
          return { messageId: "om_card_ambiguous" };
        },
        sendTextMessage: async () => ({ messageId: "om_text_unused" })
      }
    });

    const result = await bridge.handle(normalizeEvent("@PI 帮我修复 Runner bug", "om_ambiguous_project", config, database));
    const payload = JSON.stringify(sentCards[0] ?? {});

    expect(result).toEqual({ reason: "project_selection_sent", replied: true });
    expect(calls).toEqual([]);
    expect(payload).toContain("runner-api");
    expect(payload).toContain("runner-web");
    database.close();
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-ambiguous-project-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function configFixture() {
  return buildFeishuConnectorConfig({
    FEISHU_ALLOWED_CHAT_IDS: "oc_group",
    FEISHU_APP_ID: "cli_app_id",
    FEISHU_APP_SECRET: "app-secret-value"
  });
}

function fixedClock() {
  return { now: () => new Date(2026, 5, 13, 1, 2, 3) };
}

function normalizeEvent(
  text: string,
  messageId: string,
  config: ReturnType<typeof configFixture>,
  database: RunnerDatabase
) {
  const raw = messageEvent(text, messageId);
  return {
    event: normalizeFeishuMessageEvent(raw),
    ingest: ingestFeishuMessageEvent(raw, { config, database }, { transport: "websocket" })
  };
}

function insertProject(db: RunnerDatabase, id: string, name: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [id, name, `/tmp/${id}`, "2026-06-13T00:00:00Z", "2026-06-13T00:00:00Z"]
  );
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
