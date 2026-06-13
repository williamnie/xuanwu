import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getFeishuPendingProjectSelection } from "../db/repositories/feishuProjectSelection.ts";
import type { FeishuTextMessageInput } from "./feishuClient.ts";
import type { FeishuProjectContextResult } from "./feishuProjectContext.ts";
import { maybeSendFeishuProjectSelection } from "./feishuProjectSelectionBridge.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Feishu project selection bridge helper", () => {
  test("stores pending selection and sends a card for missing project task", async () => {
    const database = await openFixtureDatabase();
    const sentCards: Record<string, unknown>[] = [];
    insertProject(database, "demo", "Demo Project");

    const result = await maybeSendFeishuProjectSelection({
      clock: { now: () => new Date("2026-06-13T01:02:03Z") },
      config: () => ({ allowedChatIds: [], allowedUserIds: [], appId: "", appSecret: "", encryptKey: "", projectMappings: [], receiveMode: "websocket", verificationToken: "" }),
      database,
      runConversation: async () => ({ text: "unused" }),
      sender: {
        sendInteractiveCard: async (input) => {
          sentCards.push(input.card);
          return { messageId: "om_card_1" };
        },
        sendTextMessage: async (_input: FeishuTextMessageInput) => ({ messageId: "om_text_unused" })
      }
    }, inputFixture("开始做吧"), routeFixture(), missingContext(), "inbox_only");

    const selectionId = selectionIDFromCard(sentCards[0]);
    expect(result).toEqual({ messageId: "om_card_1", reason: "project_selection_sent", replied: true });
    expect(getFeishuPendingProjectSelection(database, selectionId)).toMatchObject({
      candidates: ["demo"],
      expires_at: "2026-06-13T01:32:03.000Z",
      original_prompt: "开始做吧",
      status: "pending"
    });
    database.close();
  });

  test("asks project selection for explicit batch continuation without project context", async () => {
    const database = await openFixtureDatabase();
    const sentCards: Record<string, unknown>[] = [];
    insertProject(database, "demo", "Demo Project");

    const result = await maybeSendFeishuProjectSelection({
      clock: { now: () => new Date("2026-06-13T01:02:03Z") },
      config: () => ({ allowedChatIds: [], allowedUserIds: [], appId: "", appSecret: "", encryptKey: "", projectMappings: [], receiveMode: "websocket", verificationToken: "" }),
      database,
      runConversation: async () => ({ text: "unused" }),
      sender: {
        sendInteractiveCard: async (input) => {
          sentCards.push(input.card);
          return { messageId: "om_card_batch" };
        },
        sendTextMessage: async (_input: FeishuTextMessageInput) => ({ messageId: "om_text_unused" })
      }
    }, inputFixture("把 #387-#391 都开始做"), {
      ...routeFixture(),
      prompt: "把 #387-#391 都开始做"
    }, missingContext(), "inbox_only");

    const selectionId = selectionIDFromCard(sentCards[0]);
    expect(result).toEqual({ messageId: "om_card_batch", reason: "project_selection_sent", replied: true });
    expect(getFeishuPendingProjectSelection(database, selectionId)).toMatchObject({
      original_prompt: "把 #387-#391 都开始做",
      status: "pending"
    });
    database.close();
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-selection-bridge-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string, name: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [id, name, `/tmp/${id}`, "2026-06-13T00:00:00Z", "2026-06-13T00:00:00Z"]
  );
}

function inputFixture(text: string) {
  return {
    event: {
      attachments: [],
      chat_id: "oc_group",
      chat_type: "group",
      dedupe_key: "feishu:message:om_1",
      mentions: [],
      message_id: "om_1",
      raw_event_ref: "",
      root_id: "",
      sender: { id: "ou_user_1", open_id: "ou_open_1", tenant_key: "", type: "user" },
      source_id: "feishu:message:om_1",
      text,
      thread_id: "",
      timestamp: "2026-06-13T01:00:00.000Z"
    },
    ingest: { dedupe_key: "feishu:message:om_1", event_id: 1, normalized_summary: {}, ok: true as const }
  };
}

function routeFixture() {
  return {
    baseConversationId: "feishu-chat-oc_group-20260613",
    conversationId: "feishu-chat-oc_group-20260613",
    epoch: 0,
    isNewCommand: false,
    prompt: "开始做吧",
    scopeKey: "feishu-chat-oc_group-20260613"
  };
}

function missingContext(): FeishuProjectContextResult {
  return {
    candidates: [],
    confidence: "none",
    projectId: "",
    reason: "no_project_context",
    source: "none",
    status: "missing"
  };
}

function selectionIDFromCard(card: Record<string, unknown> | undefined): string {
  const text = JSON.stringify(card ?? {});
  const match = text.match(/"selection_id":"([^"]+)"/);
  if (!match) throw new Error("selection_id missing from card");
  return match[1];
}
