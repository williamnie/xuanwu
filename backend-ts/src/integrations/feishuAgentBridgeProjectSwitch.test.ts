import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFeishuConversationState } from "../db/repositories/feishuConversationState.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { buildFeishuConnectorConfig, normalizeFeishuMessageEvent } from "./feishu.ts";
import { createFeishuAgentBridge } from "./feishuAgentBridge.ts";
import type { FeishuTextMessageInput } from "./feishuClient.ts";
import { ingestFeishuMessageEvent } from "./feishuIngest.ts";
import { parseFeishuProjectSwitchTarget } from "./feishuProjectSwitch.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Feishu agent bridge project switch command", () => {
  test("recognizes all project switch command aliases", () => {
    expect([
      "/p codex-issue-runner",
      "/project codex-issue-runner",
      "项目 codex-issue-runner",
      "切到 codex-issue-runner"
    ].map(parseFeishuProjectSwitchTarget)).toEqual([
      "codex-issue-runner",
      "codex-issue-runner",
      "codex-issue-runner",
      "codex-issue-runner"
    ]);
  });

  test("recognizes project hints without saving an IM current project", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    const calls: Array<{ conversationId?: string; projectId: string; prompt: string; targetProjectId?: string }> = [];
    const config = configFixture();
    insertProject(database, "codex-issue-runner", "Codex Issue Runner");
    const bridge = createFeishuAgentBridge({
      clock: fixedClock(),
      config: () => config,
      database,
      runConversation: async ({ conversationId, projectId, prompt, targetProjectId }) => {
        calls.push({ conversationId, projectId, prompt, targetProjectId });
        return { conversationId, projectId, text: "runner reply" };
      },
      sender: { sendTextMessage: async (input) => {
        sent.push(input);
        return { messageId: `om_reply_${sent.length}` };
      } }
    });

    const switched = await bridge.handle(normalizeEvent("/p codex-issue-runner", "om_project_switch", config, database));
    const next = await bridge.handle(normalizeEvent("开始做吧", "om_project_next", config, database));

    expect(switched).toEqual({ reason: "project_switch_sent", replied: true });
    expect(next).toEqual({ reason: "project_selection_sent", replied: true });
    expect(calls).toEqual([]);
    expect(sent.map((item) => item.text)).toEqual([
      "已识别 codex-issue-runner。IM 通道不会保存当前项目；请把项目名或 issue id 写在具体请求里。",
      "请选择本次操作的 Runner 项目：codex-issue-runner。也可以重新发送并在消息里带上项目名或 issue id。"
    ]);
    expect(getFeishuConversationState(database, "feishu-chat-oc_group-20260613")).toBeNull();
    database.close();
  });

  test("reports missing project switch targets without running PI", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    const calls: string[] = [];
    const config = configFixture();
    insertProject(database, "codex-issue-runner", "Codex Issue Runner");
    const bridge = createFeishuAgentBridge({
      clock: fixedClock(),
      config: () => config,
      database,
      runConversation: async ({ prompt }) => {
        calls.push(prompt);
        return { text: "should not run" };
      },
      sender: { sendTextMessage: async (input) => {
        sent.push(input);
        return { messageId: "om_reply_missing_project" };
      } }
    });

    const result = await bridge.handle(normalizeEvent("项目 missing-project", "om_project_missing", config, database));

    expect(result).toEqual({ reason: "project_switch_missing", replied: true });
    expect(calls).toEqual([]);
    expect(sent.map((item) => item.text)).toEqual([
      "没找到项目 missing-project，请换项目名或用项目列表选择。"
    ]);
    expect(getFeishuConversationState(database, "feishu-chat-oc_group-20260613")).toBeNull();
    database.close();
  });

  test("reports ambiguous project switch targets without running PI", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    const calls: string[] = [];
    const config = configFixture();
    insertProject(database, "runner-api", "Runner");
    insertProject(database, "runner-web", "Runner");
    const bridge = createFeishuAgentBridge({
      clock: fixedClock(),
      config: () => config,
      database,
      runConversation: async ({ prompt }) => {
        calls.push(prompt);
        return { text: "should not run" };
      },
      sender: { sendTextMessage: async (input) => {
        sent.push(input);
        return { messageId: "om_reply_ambiguous_project" };
      } }
    });

    const result = await bridge.handle(normalizeEvent("切到 Runner", "om_project_ambiguous", config, database));

    expect(result).toEqual({ reason: "project_switch_ambiguous", replied: true });
    expect(calls).toEqual([]);
    expect(sent.map((item) => item.text)).toEqual([
      "找到多个项目：runner-api、runner-web。请说得更精确一点，后续 issue 会用卡片选择解决。"
    ]);
    expect(getFeishuConversationState(database, "feishu-chat-oc_group-20260613")).toBeNull();
    database.close();
  });

  test("keeps /new precedence when project switch text appears inside the new prompt", async () => {
    const database = await openFixtureDatabase();
    const calls: Array<{ conversationId?: string; projectId: string; prompt: string; targetProjectId?: string }> = [];
    const config = configFixture();
    insertProject(database, "codex-issue-runner", "Codex Issue Runner");
    const bridge = createFeishuAgentBridge({
      clock: fixedClock(),
      config: () => config,
      database,
      runConversation: async ({ conversationId, projectId, prompt, targetProjectId }) => {
        calls.push({ conversationId, projectId, prompt, targetProjectId });
        return { conversationId, projectId, text: "runner reply" };
      },
      sender: { sendTextMessage: async () => ({ messageId: "om_reply_new_with_project" }) }
    });

    await bridge.handle(normalizeEvent("/new /p codex-issue-runner", "om_new_project_switch", config, database));

    expect(calls).toEqual([{
      conversationId: "feishu-chat-oc_group-20260613-n1",
      projectId: "",
      prompt: "/p codex-issue-runner",
      targetProjectId: "codex-issue-runner"
    }]);
    expect(getFeishuConversationState(database, "feishu-chat-oc_group-20260613"))
      .toMatchObject({ active_project_id: "", epoch: 1 });
    database.close();
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-project-switch-"));
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
