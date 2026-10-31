import { expect, test } from "bun:test";
import { buildFeishuConnectorConfig, normalizeFeishuMessageEvent } from "./feishu.ts";
import { createFeishuAgentBridge } from "./feishuAgentBridge.ts";
import { ingestFeishuMessageEvent } from "./feishuIngest.ts";
import { createPiMemoryItem } from "../../db/repositories/pi.ts";
import type { FeishuTextMessageInput } from "./feishuClient.ts";
import type { TestFixture } from "./feishuAgentBridge.testFixture.ts";

export function registerRoutesTrustedCapabilityQuestionsToCases(testScope: TestFixture) {
  const { openFixtureDatabase, messageEvent } = testScope;
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
  
  test("passes /memory to PI instead of executing a bridge command parser", async () => {
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
          return { text: "PI memory reply" };
        },
        sender: { sendTextMessage: async (input) => {
          sent.push(input);
          return { messageId: "om_reply_memory_command" };
        } }
      });
      const result = await bridge.handle({ event, ingest });
      expect(result).toEqual({ reason: "agent_reply_sent", replied: true });
      expect(prompts).toEqual(["/memory"]);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.text).toBe("PI memory reply");
      database.close();
    });
  
  test("passes task wording without a project to PI for autonomous clarification", async () => {
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
          return { text: "PI asks only if its tools cannot resolve the target" };
        },
        sender: { sendTextMessage: async (input) => {
          sent.push(input);
          return { messageId: "om_reply_needs_project" };
        } }
      });
  
      const result = await bridge.handle({ event, ingest });
  
      expect(result).toEqual({ reason: "agent_reply_sent", replied: true });
      expect(prompts).toEqual(["@PI 帮我修复登录 bug"]);
      expect(sent).toEqual([{
        receiveId: "oc_group",
        receiveIdType: "chat_id",
        text: "PI asks only if its tools cannot resolve the target"
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
}
