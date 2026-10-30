import { expect, test } from "bun:test";
import { buildFeishuConnectorConfig, normalizeFeishuMessageEvent } from "./feishu.ts";
import { createFeishuAgentBridge } from "./feishuAgentBridge.ts";
import { ingestFeishuMessageEvent } from "./feishuIngest.ts";
import type { FeishuReactionInput, FeishuTextMessageInput } from "./feishuClient.ts";
import type { TestFixture } from "./feishuAgentBridge.testFixture.ts";

export function registerAddsAQuickFeishuReactionCases(testScope: TestFixture) {
  const { openFixtureDatabase, messageEvent, insertProject } = testScope;
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
      }
    });
  
  test("passes a Feishu project mapping as an explainable one-shot target", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "demo", "Demo");
      const sent: FeishuTextMessageInput[] = [];
      const calls: Array<{ projectId: string; prompt: string; targetProjectId?: string; targetProjectSource?: string }> = [];
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
        runConversation: async ({ projectId, prompt, targetProjectId, targetProjectSource }) => {
          calls.push({ projectId, prompt, targetProjectId, targetProjectSource });
          return { text: "hello from runner" };
        },
        sender: { sendTextMessage: async (input) => {
          sent.push(input);
          return { messageId: "om_reply_1" };
        } }
      });
  
      const result = await bridge.handle({ event, ingest });
  
      expect(result).toEqual({ reason: "agent_reply_sent", replied: true });
      expect(calls).toEqual([{
        projectId: "",
        prompt: "@PI 帮我修复这个 bug",
        targetProjectId: "demo",
        targetProjectSource: "mapping_default"
      }]);
      expect(sent).toEqual([{
        receiveId: "oc_group",
        receiveIdType: "chat_id",
        text: "hello from runner"
      }]);
      database.close();
    });
  
  test("passes ambiguous multi-project wording to PI without a pre-LLM project card", async () => {
      const database = await openFixtureDatabase();
      insertProject(database, "xuanwu", "Xuanwu");
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
          return { text: "PI will resolve the target or ask one question" };
        },
        sender: { sendTextMessage: async (input) => {
          sent.push(input);
          return { messageId: "om_reply_all_issues_project_target" };
        } }
      });
  
      const result = await bridge.handle({ event, ingest });
  
      expect(result).toEqual({ reason: "agent_reply_sent", replied: true });
      expect(calls).toEqual([{ projectId: "", prompt: "开始所有issue" }]);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.text).toBe("PI will resolve the target or ask one question");
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
}
