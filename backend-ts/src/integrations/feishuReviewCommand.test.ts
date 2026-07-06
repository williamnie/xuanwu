import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { listIssues } from "../db/repositories/issues.ts";
import { listPiActions, listPiMemoryItems } from "../db/repositories/pi.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { runPiConversationPrompt } from "../http/piConversationApi.ts";
import { buildFeishuConnectorConfig, normalizeFeishuMessageEvent } from "./feishu.ts";
import { createFeishuAgentBridge } from "./feishuAgentBridge.ts";
import type { FeishuTextMessageInput } from "./feishuClient.ts";
import { ingestFeishuMessageEvent } from "./feishuIngest.ts";
import { normalizeFeishuReviewReply } from "./feishuReviewCommand.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Feishu /review command", () => {
  test("routes /review to the active Feishu PI conversation without creating issues", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    const calls: Array<{ conversationId: string; intent?: string; projectId: string; prompt: string }> = [];
    const config = configFixture();
    const bridge = createFeishuAgentBridge({
      clock: { now: () => new Date(2026, 5, 14, 9, 0, 0) },
      config: () => config,
      database,
      runConversation: async ({ conversationId, intent, projectId, prompt }) => {
        calls.push({ conversationId, intent, projectId, prompt });
        return { conversationId, projectId, text: reviewReply() };
      },
      sender: { sendTextMessage: async (input) => {
        sent.push(input);
        return { messageId: `om_reply_review_${sent.length}` };
      } }
    });
    await bridge.handle(handleInput("/new", "om_review_new", config, database));

    const result = await bridge.handle(handleInput("/review", "om_review_command", config, database));

    expect(result).toEqual({ reason: "agent_reply_sent", replied: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      conversationId: "feishu-chat-oc_group-20260614-n1",
      intent: "review",
      projectId: ""
    });
    expect(calls[0]?.prompt).toContain("Feishu /review command");
    expect(calls[0]?.prompt).toContain("Do not create or enqueue runner issues");
    expect(sent.at(-1)?.text).toContain("记忆候选");
    expect(sent.at(-1)?.text).toContain("待办候选");
    expect(sent.at(-1)?.text).toContain("需要你确认/授权的事项");
    expect(listIssues(database, { projectId: "demo" })).toEqual([]);
    database.close();
  });

  test("review runtime writes only disabled memory candidates and denies issue mutations", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-feishu-review-api", provider: "pi-feishu-review" });
    try {
      faux.setResponses([reviewToolCalls(), fauxAssistantMessage(reviewReply())]);
      insertProject(database, "demo");
      insertIssue(database, 55);
      insertFauxAgent(database, "pi-feishu-review");
      writeFauxModelsConfig(database, "pi-feishu-review");

      const result = await runPiConversationPrompt({ database }, {
        conversationId: "feishu-review",
        intent: "review",
        projectId: "demo",
        prompt: "Feishu /review command: review the recent active conversation.",
        title: "Feishu"
      });

      expect(result.text).toContain("记忆候选");
      expect(listIssues(database, { projectId: "demo" })).toMatchObject([
        { id: 55, status: "triage", title: "Existing issue" }
      ]);
      expect(listPiMemoryItems(database, { disabled: 1 })).toMatchObject([
        { disabled: 1, kind: "preference", scope_id: "demo", source_id: "feishu-review" }
      ]);
      expect(listPiMemoryItems(database, { disabled: 0 })).toEqual([]);
      expect(listPiActions(database, { status: "completed" }).map((action) => action.action_type))
        .toEqual(["memory.write_candidate"]);
      expect(listPiActions(database, { status: "denied" }).map((action) => action.action_type).sort())
        .toEqual(["issue.create", "issue.enqueue"]);
    } finally {
      faux.unregister();
      database.close();
    }
  });

  test("redacts sensitive review replies and preserves required sections", () => {
    const text = normalizeFeishuReviewReply([
      "记忆候选",
      "- CODEX_API_KEY=fixture-secret",
      "",
      "待办候选",
      "- Check /Users/xiaobei/private/project",
      "",
      "需要你确认/授权的事项",
      "- at handler (/Users/xiaobei/private/file.ts:1:2)"
    ].join("\n"));

    expect(text).toContain("记忆候选");
    expect(text).toContain("待办候选");
    expect(text).toContain("需要你确认/授权的事项");
    expect(text).not.toContain("fixture-secret");
    expect(text).not.toContain("/Users/xiaobei");
    expect(text).not.toContain("file.ts:1:2");
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-review-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function configFixture() {
  return buildFeishuConnectorConfig({
    FEISHU_ALLOWED_CHAT_IDS: "oc_group",
    FEISHU_PROJECT_MAPPINGS: "chat:oc_group=demo",
    FEISHU_APP_ID: "cli_app_id",
    FEISHU_APP_SECRET: "app-secret-value"
  });
}

function handleInput(
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

function reviewToolCalls() {
  return fauxAssistantMessage([
    fauxToolCall("memory_write_candidate", {
      kind: "preference",
      content: "Prefer concise Feishu review summaries"
    }, { id: "memory-candidate" }),
    fauxToolCall("issue_create_proposal", {
      description: "Should not be created from /review",
      title: "Forbidden review issue"
    }, { id: "issue-create" }),
    fauxToolCall("issue_enqueue_proposal", {
      issue_id: 55,
      rationale: "Should not enqueue from /review"
    }, { id: "issue-enqueue" })
  ], { stopReason: "toolUse" });
}

function reviewReply(): string {
  return [
    "记忆候选",
    "- Prefer concise Feishu review summaries",
    "",
    "待办候选",
    "- Should not be created automatically.",
    "",
    "需要你确认/授权的事项",
    "- 请确认是否写入记忆。"
  ].join("\n");
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "2026-06-14T00:00:00Z", "2026-06-14T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, id: number): void {
  db.sqlite.run(
    `insert into issues (id, project_id, title, status, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [id, "demo", "Existing issue", "triage", "2026-06-14T00:00:00Z", "2026-06-14T00:00:00Z"]
  );
}

function insertFauxAgent(db: RunnerDatabase, provider: string): void {
  db.sqlite.run(
    `insert into pi_agents (id, name, model_provider, model_id, thinking_level, enabled, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["pi-faux", "PI Faux", provider, "faux-1", "off", 1, "2026-06-14T00:00:00Z", "2026-06-14T00:00:00Z"]
  );
}

function writeFauxModelsConfig(db: RunnerDatabase, provider: string): void {
  const agentDir = join(db.path, "..", "pi-runtime", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      [provider]: {
        api: `${provider}-api`,
        apiKey: "test",
        baseUrl: "http://localhost:0",
        models: [{ id: "faux-1" }]
      }
    }
  }));
}
