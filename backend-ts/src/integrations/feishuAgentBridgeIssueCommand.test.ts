import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { buildFeishuConnectorConfig, normalizeFeishuMessageEvent } from "./feishu.ts";
import { createFeishuAgentBridge } from "./feishuAgentBridge.ts";
import type { FeishuTextMessageInput } from "./feishuClient.ts";
import { ingestFeishuMessageEvent } from "./feishuIngest.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Feishu agent bridge /issue command", () => {
  test("does not use Feishu mapping as the /issue Runner project", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    const calls: Array<{ projectId: string; prompt: string; targetProjectId?: string }> = [];
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_PROJECT_MAPPINGS: "chat:oc_group=demo",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    insertProject(database, "demo", "Demo");
    const bridge = createFeishuAgentBridge({
      config: () => config,
      database,
      runConversation: async ({ projectId, prompt, targetProjectId }) => {
        calls.push({ projectId, prompt, targetProjectId });
        return { projectId, text: "已创建 runner issue #42（demo），executor session 已启动。查看：Runner issue #42。" };
      },
      sender: { sendTextMessage: async (input) => {
        sent.push(input);
        return { messageId: "om_reply_issue_1" };
      } }
    });

    const result = await bridge.handle(normalizeEvent(
      "/issue 在 codex-issue-runner 修复飞书上下文爆炸",
      "om_issue_command_1",
      config,
      database
    ));

    expect(result).toEqual({ reason: "project_clarification_sent", replied: true });
    expect(calls).toEqual([]);
    expect(sent.map((item) => item.text)).toEqual([
      "这是哪个项目？你可以直接回复项目名，或把项目名带在任务里。"
    ]);
    database.close();
  });

  test("resolves a project named in the /issue command when chat mapping is absent", async () => {
    const database = await openFixtureDatabase();
    const calls: Array<{ projectId: string; prompt: string; targetProjectId?: string }> = [];
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    insertProject(database, "codex-issue-runner", "Codex Issue Runner");
    const bridge = createFeishuAgentBridge({
      config: () => config,
      database,
      runConversation: async ({ projectId, prompt, targetProjectId }) => {
        calls.push({ projectId, prompt, targetProjectId });
        return { projectId, targetProjectId, text: "已创建 runner issue #44（codex-issue-runner），executor session 已启动。" };
      },
      sender: { sendTextMessage: async () => ({ messageId: "om_reply_issue_explicit_project" }) }
    });

    const result = await bridge.handle(normalizeEvent(
      "/issue 在 codex-issue-runner 修复飞书上下文爆炸",
      "om_issue_explicit_project",
      config,
      database
    ));

    expect(result).toEqual({ reason: "agent_reply_sent", replied: true });
    expect(calls).toMatchObject([{
      projectId: "",
      targetProjectId: "codex-issue-runner",
      prompt: expect.stringContaining("Task: 在 codex-issue-runner 修复飞书上下文爆炸")
    }]);
    database.close();
  });

  test("asks one natural project question for /issue commands without project context", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    const calls: string[] = [];
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    insertProject(database, "demo", "Demo");
    const bridge = createFeishuAgentBridge({
      config: () => config,
      database,
      runConversation: async ({ prompt }) => {
        calls.push(prompt);
        return { text: "should not run" };
      },
      sender: { sendTextMessage: async (input) => {
        sent.push(input);
        return { messageId: "om_reply_issue_missing_project" };
      } }
    });

    const result = await bridge.handle(normalizeEvent(
      "/issue 整理上下文治理",
      "om_issue_missing_project",
      config,
      database
    ));

    expect(result).toEqual({ reason: "project_clarification_sent", replied: true });
    expect(calls).toEqual([]);
    expect(sent.map((item) => item.text)).toEqual([
      "这是哪个项目？你可以直接回复项目名，或把项目名带在任务里。"
    ]);
    database.close();
  });

  test("uses the mapped one-shot target once and does not reply twice when /issue is replayed", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    const calls: string[] = [];
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_PROJECT_MAPPINGS: "chat:oc_group=demo",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    insertProject(database, "demo", "Demo");
    const bridge = createFeishuAgentBridge({
      config: () => config,
      database,
      runConversation: async ({ prompt }) => {
        calls.push(prompt);
        return { text: "已创建 runner issue #43，并开始执行。" };
      },
      sender: { sendTextMessage: async (input) => {
        sent.push(input);
        return { messageId: `om_reply_issue_${sent.length}` };
      } }
    });
    const input = normalizeEvent("/issue 整理上下文治理", "om_issue_replay", config, database);

    await bridge.handle(input);
    const replay = await bridge.handle(input);

    expect(replay).toEqual({ reason: "duplicate_reply", replied: false });
    expect(calls).toHaveLength(1);
    expect(sent).toHaveLength(1);
    database.close();
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-issue-command-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function normalizeEvent(
  text: string,
  messageId: string,
  config: ReturnType<typeof buildFeishuConnectorConfig>,
  database: RunnerDatabase
) {
  const raw = messageEvent(text, messageId);
  return {
    event: normalizeFeishuMessageEvent(raw),
    ingest: ingestFeishuMessageEvent(raw, { config, database }, { transport: "websocket" })
  };
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

function insertProject(db: RunnerDatabase, id: string, name: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [id, name, `/tmp/${id}`, "2026-06-14T00:00:00Z", "2026-06-14T00:00:00Z"]
  );
}
