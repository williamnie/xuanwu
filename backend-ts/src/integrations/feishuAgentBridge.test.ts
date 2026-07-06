import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFeishuConnectorConfig, normalizeFeishuMessageEvent } from "./feishu.ts";
import { createFeishuAgentBridge } from "./feishuAgentBridge.ts";
import { ingestFeishuMessageEvent } from "./feishuIngest.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createPiMemoryItem } from "../db/repositories/pi.ts";
import type { FeishuReactionInput, FeishuTextMessageInput } from "./feishuClient.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Feishu agent bridge", () => {
  test("adds a quick Feishu reaction before running the PI conversation", async () => {
    const database = await openFixtureDatabase();
    const actions: string[] = [];
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    const raw = messageEvent("hi", "om_agent_ack_reaction");
    const event = normalizeFeishuMessageEvent(raw);
    const ingest = ingestFeishuMessageEvent(raw, { config, database }, { transport: "websocket" });
    const bridge = createFeishuAgentBridge({
      config: () => config,
      database,
      runConversation: async () => {
        actions.push("run");
        return { text: "我收到了。" };
      },
      sender: {
        addMessageReaction: async (input: FeishuReactionInput) => {
          actions.push(`reaction:${input.messageId}:${input.emojiType}`);
          return { reactionId: "mr_ack_1" };
        },
        sendTextMessage: async () => {
          actions.push("reply");
          return { messageId: "om_reply_ack_reaction" };
        }
      }
    });

    const result = await bridge.handle({ event, ingest });
    const replay = await bridge.handle({ event, ingest });

    expect(result).toEqual({ reason: "agent_reply_sent", replied: true });
    expect(replay).toEqual({ reason: "duplicate_reply", replied: false });
    expect(actions).toEqual(["reaction:om_agent_ack_reaction:OK", "run", "reply"]);
    database.close();
  });

  test("continues replying when the quick Feishu reaction fails", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (value?: unknown) => { warnings.push(String(value)); };
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    const raw = messageEvent("hi", "om_agent_ack_reaction_error");
    const event = normalizeFeishuMessageEvent(raw);
    const ingest = ingestFeishuMessageEvent(raw, { config, database }, { transport: "websocket" });
    const bridge = createFeishuAgentBridge({
      config: () => config,
      database,
      runConversation: async () => ({ text: "reaction 挂了也继续回复" }),
      sender: {
        addMessageReaction: async () => {
          throw new Error("reaction permission denied FEISHU_APP_SECRET=app-secret-value");
        },
        sendTextMessage: async (input) => {
          sent.push(input);
          return { messageId: "om_reply_ack_reaction_error" };
        }
      }
    });

    try {
      const result = await bridge.handle({ event, ingest });
      expect(result).toEqual({ reason: "agent_reply_sent", replied: true });
      expect(sent).toHaveLength(1);
      expect(warnings[0]).toContain("feishu_ack_reaction");
      expect(warnings[0]).not.toContain("app-secret-value");
    } finally {
      console.warn = originalWarn;
      database.close();
    }
  });

  test("does not treat Feishu project mapping as an IM conversation project", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    const prompts: string[] = [];
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_PROJECT_MAPPINGS: "chat:oc_group=demo",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    const raw = messageEvent("@PI 帮我修复这个 bug");
    const event = normalizeFeishuMessageEvent(raw);
    const ingest = ingestFeishuMessageEvent(raw, { config, database }, { transport: "websocket" });
    const bridge = createFeishuAgentBridge({
      config: () => config,
      database,
      runConversation: async ({ prompt }) => {
        prompts.push(prompt);
        return { text: "hello from runner" };
      },
      sender: { sendTextMessage: async (input) => {
        sent.push(input);
        return { messageId: "om_reply_1" };
      } }
    });

    const result = await bridge.handle({ event, ingest });

    expect(result).toEqual({ reason: "project_clarification_sent", replied: true });
    expect(prompts).toEqual([]);
    expect(sent).toEqual([{
      receiveId: "oc_group",
      receiveIdType: "chat_id",
      text: "我收到任务了，但还不知道要交给哪个 Runner 项目。请在消息里带上项目名或 issue id 后再发。"
    }]);
    database.close();
  });

  test("asks for a one-shot project target instead of assuming codex-issue-runner from generic issue wording", async () => {
    const database = await openFixtureDatabase();
    insertProject(database, "codex-issue-runner", "Codex Issue Runner");
    insertProject(database, "movo-mobile", "movo-mobile");
    const sent: FeishuTextMessageInput[] = [];
    const calls: Array<{ projectId: string; prompt: string }> = [];
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    const raw = messageEvent("开始所有issue", "om_agent_all_issues_no_current_project");
    const event = normalizeFeishuMessageEvent(raw);
    const ingest = ingestFeishuMessageEvent(raw, { config, database }, { transport: "websocket" });
    const bridge = createFeishuAgentBridge({
      config: () => config,
      database,
      runConversation: async ({ projectId, prompt }) => {
        calls.push({ projectId, prompt });
        return { text: "should not run before one-shot target selection" };
      },
      sender: { sendTextMessage: async (input) => {
        sent.push(input);
        return { messageId: "om_reply_all_issues_project_target" };
      } }
    });

    const result = await bridge.handle({ event, ingest });

    expect(result).toEqual({ reason: "project_selection_sent", replied: true });
    expect(calls).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("请选择本次操作的 Runner 项目");
    expect(sent[0]?.text).toContain("codex-issue-runner");
    expect(sent[0]?.text).toContain("movo-mobile");
    database.close();
  });

  test("routes trusted chat-only messages to PI conversation for natural replies", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    const prompts: string[] = [];
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    const raw = messageEvent("hi", "om_agent_chat_only");
    const event = normalizeFeishuMessageEvent(raw);
    const ingest = ingestFeishuMessageEvent(raw, { config, database }, { transport: "websocket" });
    const bridge = createFeishuAgentBridge({
      config: () => config,
      database,
      runConversation: async ({ prompt }) => {
        prompts.push(prompt);
        return { text: "我在，这件事我可以继续帮你跟进。" };
      },
      sender: { sendTextMessage: async (input) => {
        sent.push(input);
        return { messageId: "om_reply_chat_only" };
      } }
    });

    const result = await bridge.handle({ event, ingest });

    expect(result).toEqual({ reason: "agent_reply_sent", replied: true });
    expect(prompts).toEqual(["hi"]);
    expect(sent).toEqual([{
      receiveId: "oc_group",
      receiveIdType: "chat_id",
      text: "我在，这件事我可以继续帮你跟进。"
    }]);
    database.close();
  });

  test("routes trusted capability questions to PI conversation even when no project is mapped", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    const calls: Array<{ prompt: string; projectId: string }> = [];
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    const raw = messageEvent("你能帮我做什么", "om_agent_capability_question");
    const event = normalizeFeishuMessageEvent(raw);
    const ingest = ingestFeishuMessageEvent(raw, { config, database }, { transport: "websocket" });
    const bridge = createFeishuAgentBridge({
      config: () => config,
      database,
      runConversation: async ({ prompt, projectId }) => {
        calls.push({ prompt, projectId });
        return { text: "我可以直接聊天，也可以帮你把明确任务建成 issue 并跟进执行。" };
      },
      sender: { sendTextMessage: async (input) => {
        sent.push(input);
        return { messageId: "om_reply_capability_question" };
      } }
    });

    const result = await bridge.handle({ event, ingest });

    expect(result).toEqual({ reason: "agent_reply_sent", replied: true });
    expect(calls).toEqual([{ prompt: "你能帮我做什么", projectId: "" }]);
    expect(sent).toEqual([{
      receiveId: "oc_group",
      receiveIdType: "chat_id",
      text: "我可以直接聊天，也可以帮你把明确任务建成 issue 并跟进执行。"
    }]);
    database.close();
  });

  test("handles /memory command directly without starting Runner agent", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    const prompts: string[] = [];
    createPiMemoryItem(database, {
      id: "12345678-1111-4111-8111-123456789abc",
      scope: "global",
      scope_id: "",
      kind: "preference",
      content: "Prefer compact memory review",
      source_type: "pi.conversation",
      source_id: "conv-1",
      confidence: "high",
      disabled: 1
    });
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_PROJECT_MAPPINGS: "chat:oc_group=demo",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    const raw = messageEvent("/memory", "om_agent_memory_command");
    const event = normalizeFeishuMessageEvent(raw);
    const ingest = ingestFeishuMessageEvent(raw, { config, database }, { transport: "websocket" });
    const bridge = createFeishuAgentBridge({
      config: () => config,
      database,
      runConversation: async ({ prompt }) => {
        prompts.push(prompt);
        return { text: "should not run" };
      },
      sender: { sendTextMessage: async (input) => {
        sent.push(input);
        return { messageId: "om_reply_memory_command" };
      } }
    });
    const result = await bridge.handle({ event, ingest });
    expect(result).toEqual({ reason: "memory_candidates_listed", replied: true });
    expect(prompts).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("待审核记忆");
    expect(sent[0]?.text).toContain("12345678");
    database.close();
  });

  test("asks for project mapping instead of starting Runner agent for task messages without a project", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    const prompts: string[] = [];
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    const raw = messageEvent("@PI 帮我修复登录 bug", "om_agent_needs_project");
    const event = normalizeFeishuMessageEvent(raw);
    const ingest = ingestFeishuMessageEvent(raw, { config, database }, { transport: "websocket" });
    const bridge = createFeishuAgentBridge({
      config: () => config,
      database,
      runConversation: async ({ prompt }) => {
        prompts.push(prompt);
        return { text: "should not run" };
      },
      sender: { sendTextMessage: async (input) => {
        sent.push(input);
        return { messageId: "om_reply_needs_project" };
      } }
    });

    const result = await bridge.handle({ event, ingest });

    expect(result).toEqual({ reason: "project_clarification_sent", replied: true });
    expect(prompts).toEqual([]);
    expect(sent).toEqual([{
      receiveId: "oc_group",
      receiveIdType: "chat_id",
      text: "我收到任务了，但还不知道要交给哪个 Runner 项目。请在消息里带上项目名或 issue id 后再发。"
    }]);
    database.close();
  });

  test("does not reply twice for the same Feishu message id", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    const raw = messageEvent("hi again");
    const event = normalizeFeishuMessageEvent(raw);
    const ingest = ingestFeishuMessageEvent(raw, { config, database }, { transport: "websocket" });
    const bridge = createFeishuAgentBridge({
      config: () => config,
      database,
      runConversation: async () => ({ text: "runner once" }),
      sender: { sendTextMessage: async (input) => {
        sent.push(input);
        return { messageId: "om_reply_1" };
      } }
    });

    await bridge.handle({ event, ingest });
    await bridge.handle({ event, ingest });

    expect(sent).toHaveLength(1);
    database.close();
  });

  test("suppresses concurrent replays for the same Feishu message while the first reply is still running", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    const calls: string[] = [];
    let releaseRunner: () => void = () => {};
    let runnerStarted: Promise<void>;
    let markRunnerStarted: () => void = () => {};
    runnerStarted = new Promise<void>((resolve) => {
      markRunnerStarted = resolve;
    });
    const runnerGate = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    const raw = messageEvent("hi concurrently", "om_agent_concurrent_replay");
    const event = normalizeFeishuMessageEvent(raw);
    const ingest = ingestFeishuMessageEvent(raw, { config, database }, { transport: "websocket" });
    const bridge = createFeishuAgentBridge({
      config: () => config,
      database,
      runConversation: async ({ prompt }) => {
        calls.push(prompt);
        markRunnerStarted();
        await runnerGate;
        return { text: "runner once" };
      },
      sender: { sendTextMessage: async (input) => {
        sent.push(input);
        return { messageId: `om_reply_${sent.length}` };
      } }
    });

    const first = bridge.handle({ event, ingest });
    await runnerStarted;
    const second = bridge.handle({ event, ingest });
    releaseRunner();
    const results = await Promise.all([first, second]);

    expect(results.map((item) => item.reason).sort()).toEqual(["agent_reply_sent", "duplicate_reply_in_flight"]);
    expect(calls).toEqual(["hi concurrently"]);
    expect(sent).toEqual([{
      receiveId: "oc_group",
      receiveIdType: "chat_id",
      text: "runner once"
    }]);
    database.close();
  });

  test("reports Runner errors as a natural Feishu reply", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    insertProject(database, "demo", "Demo");
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_PROJECT_MAPPINGS: "chat:oc_group=demo",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    const raw = messageEvent("@PI 帮我修复 demo 登录 bug", "om_agent_runner_error");
    const event = normalizeFeishuMessageEvent(raw);
    const ingest = ingestFeishuMessageEvent(raw, { config, database }, { transport: "websocket" });
    const bridge = createFeishuAgentBridge({
      config: () => config,
      database,
      runConversation: async () => {
        throw new Error("provider failed CODEX_API_KEY=secret /Users/xiaobei/private");
      },
      sender: { sendTextMessage: async (input) => {
        sent.push(input);
        return { messageId: "om_reply_runner_error" };
      } }
    });

    const result = await bridge.handle({ event, ingest });
    const text = sent[0]?.text ?? "";

    expect(result).toEqual({ reason: "agent_reply_sent", replied: true });
    expect(text).toContain("尝试交给 Runner 时出错");
    expect(text).not.toContain("Runner agent failed");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("/Users/xiaobei/private");
    database.close();
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-agent-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function messageEvent(text: string, messageId = "om_agent_1"): Record<string, unknown> {
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
    [id, name, `/tmp/${id}`, "2026-06-13T00:00:00Z", "2026-06-13T00:00:00Z"]
  );
}
