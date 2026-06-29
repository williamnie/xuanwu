import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { listSyncOutbox } from "../db/repositories/imReplyOutbox.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { listActivePiIssueCompletionWatches } from "../db/repositories/pi.ts";
import { evaluatePiIssueCompletionWatchesForIssue } from "../pi/issueCompletionWatchEvaluator.ts";
import { buildFeishuConnectorConfig, normalizeFeishuMessageEvent } from "./feishu.ts";
import { createFeishuAgentBridge } from "./feishuAgentBridge.ts";
import type { FeishuTextMessageInput } from "./feishuClient.ts";
import { ingestFeishuMessageEvent } from "./feishuIngest.ts";
import { queueReadyFeishuCompletionWatchNotifications } from "./feishuCompletionWatchNotifications.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Feishu completion watch command", () => {
  test("creates a watch for current project unfinished issues and replies with trustable details", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    const calls: string[] = [];
    insertProject(database, "movo-web", "Movo Web");
    const first = createIssue(database, { project_id: "movo-web", title: "Timeline streaming", status: "todo" });
    const second = createIssue(database, { project_id: "movo-web", title: "Artifact render", status: "in_progress" });
    createIssue(database, { project_id: "movo-web", title: "Already done", status: "done" });
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_PROJECT_MAPPINGS: "chat:oc_group=movo-web",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    const bridge = createFeishuAgentBridge({
      config: () => config,
      database,
      runConversation: async ({ prompt }) => {
        calls.push(prompt);
        return { text: "我不能常驻等未来再主动发消息。" };
      },
      sender: fakeSender(sent)
    });

    const result = await bridge.handle(normalizeEvent(
      "现在还有2个issue没完成，等他们做完你通知我下",
      "om_watch_current_project",
      config,
      database
    ));

    const watches = listActivePiIssueCompletionWatches(database);
    expect(result).toEqual({ reason: "completion_watch_created", replied: true });
    expect(calls).toEqual([]);
    expect(watches).toHaveLength(1);
    expect(watches[0]?.items.map((item) => item.issue_id)).toEqual([first.id, second.id]);
    expect(sent[0]?.text).toContain(`watch_id: ${watches[0]?.id}`);
    expect(sent[0]?.text).toContain(`issue ids: #${first.id}, #${second.id}`);
    expect(sent[0]?.text).toContain("current status: active");
    expect(sent[0]?.text).toContain("trigger condition: all watched issues reach terminal status");
    expect(sent[0]?.text).not.toContain("不能常驻");

    satisfyIssue(database, first.id, "done", "movo-web");
    satisfyIssue(database, second.id, "failed", "movo-web");
    const queued = queueReadyFeishuCompletionWatchNotifications(database);
    expect(queued).toMatchObject({ failed: 0, queued: 1 });
    expect(listSyncOutbox(database, { source: "feishu" })[0]).toMatchObject({
      target_chat_id: "oc_group",
      target_message_id: "om_watch_current_project"
    });
    database.close();
  });

  test("creates a watch for explicit issue ids without project mapping", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    insertProject(database, "demo", "Demo");
    const first = createIssue(database, { project_id: "demo", title: "First", status: "todo" });
    const second = createIssue(database, { project_id: "demo", title: "Second", status: "triage" });
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    const bridge = createFeishuAgentBridge({
      config: () => config,
      database,
      runConversation: async () => ({ text: "should not run" }),
      sender: fakeSender(sent)
    });

    const result = await bridge.handle(normalizeEvent(
      `等 #${first.id} #${second.id} 做完通知我`,
      "om_watch_explicit_ids",
      config,
      database
    ));

    const watch = listActivePiIssueCompletionWatches(database)[0];
    expect(result).toEqual({ reason: "completion_watch_created", replied: true });
    expect(watch?.project_id).toBe("demo");
    expect(watch?.items.map((item) => item.issue_id)).toEqual([first.id, second.id]);
    expect(sent[0]?.text).toContain(`issue ids: #${first.id}, #${second.id}`);
    database.close();
  });

  test("creates a watch for a named project's remaining unfinished issues", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    insertProject(database, "demo", "Demo");
    insertProject(database, "movo-web", "Movo Web");
    createIssue(database, { project_id: "demo", title: "Other todo", status: "todo" });
    const target = createIssue(database, { project_id: "movo-web", title: "Movo remaining", status: "todo" });
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    const bridge = createFeishuAgentBridge({
      config: () => config,
      database,
      runConversation: async () => ({ text: "should not run" }),
      sender: fakeSender(sent)
    });

    const result = await bridge.handle(normalizeEvent(
      "movo-web 剩下的 issue 做完通知我",
      "om_watch_named_project",
      config,
      database
    ));

    const watch = listActivePiIssueCompletionWatches(database)[0];
    expect(result).toEqual({ reason: "completion_watch_created", replied: true });
    expect(watch?.project_id).toBe("movo-web");
    expect(watch?.items.map((item) => item.issue_id)).toEqual([target.id]);
    database.close();
  });

  test("asks instead of creating a watch when multiple projects have unfinished issues", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    insertProject(database, "demo", "Demo");
    insertProject(database, "movo-web", "Movo Web");
    createIssue(database, { project_id: "demo", title: "Demo todo", status: "todo" });
    createIssue(database, { project_id: "movo-web", title: "Movo todo", status: "todo" });
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_PROJECT_MAPPINGS: "chat:oc_group=demo",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    const bridge = createFeishuAgentBridge({
      config: () => config,
      database,
      runConversation: async () => ({ text: "should not run" }),
      sender: fakeSender(sent)
    });

    const result = await bridge.handle(normalizeEvent(
      "剩下的 issue 做完通知我",
      "om_watch_ambiguous_projects",
      config,
      database
    ));

    expect(result).toEqual({ reason: "completion_watch_project_clarification", replied: true });
    expect(listActivePiIssueCompletionWatches(database)).toHaveLength(0);
    expect(sent[0]?.text).toContain("多个项目还有未完成 issue");
    expect(sent[0]?.text).toContain("demo");
    expect(sent[0]?.text).toContain("movo-web");
    database.close();
  });

  test("asks for confirmation when stated unfinished count differs from actual targets", async () => {
    const database = await openFixtureDatabase();
    const sent: FeishuTextMessageInput[] = [];
    insertProject(database, "movo-web", "Movo Web");
    createIssue(database, { project_id: "movo-web", title: "Only one", status: "todo" });
    const config = buildFeishuConnectorConfig({
      FEISHU_ALLOWED_CHAT_IDS: "oc_group",
      FEISHU_PROJECT_MAPPINGS: "chat:oc_group=movo-web",
      FEISHU_APP_ID: "cli_app_id",
      FEISHU_APP_SECRET: "app-secret-value"
    });
    const bridge = createFeishuAgentBridge({
      config: () => config,
      database,
      runConversation: async () => ({ text: "should not run" }),
      sender: fakeSender(sent)
    });

    const result = await bridge.handle(normalizeEvent(
      "现在还有2个issue没完成，等他们做完通知我下",
      "om_watch_count_mismatch",
      config,
      database
    ));

    expect(result).toEqual({ reason: "completion_watch_count_confirmation", replied: true });
    expect(listActivePiIssueCompletionWatches(database)).toHaveLength(0);
    expect(sent[0]?.text).toContain("你说的是 2 个");
    expect(sent[0]?.text).toContain("当前找到 1 个");
    database.close();
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-completion-watch-"));
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
    `insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, `/tmp/${id}`, "codex", '{"capabilities":["issue_execution"]}', 1,
      "2026-06-29T00:00:00Z", "2026-06-29T00:00:00Z"]
  );
}

function satisfyIssue(db: RunnerDatabase, issueId: number, status: string, projectId: string): void {
  updateIssue(db, issueId, { status });
  evaluatePiIssueCompletionWatchesForIssue(db, {
    eventID: `event-${issueId}-${status}`,
    eventType: "issue.status_changed",
    issueID: issueId,
    projectID: projectId,
    status
  });
}

function fakeSender(sent: FeishuTextMessageInput[]) {
  return { sendTextMessage: async (input: FeishuTextMessageInput) => {
    sent.push(input);
    return { messageId: `om_reply_${sent.length}` };
  } };
}
