import { expect, test } from "bun:test";
import { buildFeishuConnectorConfig, normalizeFeishuMessageEvent } from "./feishu.ts";
import { createFeishuAgentBridge } from "./feishuAgentBridge.ts";
import { ingestFeishuMessageEvent } from "./feishuIngest.ts";
import type { FeishuTextMessageInput } from "./feishuClient.ts";
import type { TestFixture } from "./feishuAgentBridge.testFixture.ts";

export function registerReportsRunnerErrorsAsACases(testScope: TestFixture) {
  const { openFixtureDatabase, messageEvent, insertProject } = testScope;
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
      expect(text).toContain("暂时没接住这条请求");
      expect(text).not.toContain("Runner agent failed");
      expect(text).not.toContain("secret");
      expect(text).not.toContain("/Users/xiaobei/private");
      database.close();
    });
}
