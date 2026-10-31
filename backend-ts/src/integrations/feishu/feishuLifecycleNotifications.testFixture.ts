import { afterEach, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createExternalEvent } from "../../db/repositories/externalEvents.ts";
import { createExternalLink } from "../../db/repositories/externalLinks.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { createPiAction, listPiNotificationIntents } from "../../db/repositories/pi.ts";
import { useDatabaseCleanup } from "../../testing/harness.ts";



export function createTestFixture() {
  const trackDatabase = useDatabaseCleanup();

  const tempRoots: string[] = [];

  afterEach(async () => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true });
    }
  });

  async function fixtureDatabase(): Promise<RunnerDatabase> {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-feishu-lifecycle-intent-"));
    tempRoots.push(root);
    const db = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
    db.sqlite.run(
      `insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["demo", "Demo", join(root, "project"), "codex", '{"capabilities":["issue_execution"]}', 1,
        "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
    );
    return db;
  }

  function linkedFeishuIssue(db: RunnerDatabase, input: { conversationID?: string } = {}): number {
    const issue = createIssue(db, { project_id: "demo", title: "Feishu task", status: "triage" });
    const event = createExternalEvent(db, {
      content: "帮我修复问题",
      dedupe_key: `feishu:message:om_task_${issue.id}`,
      external_id: `om_task_${issue.id}`,
      normalized_message: { chat_id: "oc_group", message_id: `om_task_${issue.id}` },
      source: "feishu"
    });
    createExternalLink(db, {
      conversation_id: input.conversationID ?? "oc_group",
      external_event_id: event.id,
      external_type: "feishu_message",
      issue_id: issue.id,
      project_id: "demo",
      relationship: "created_issue",
      source: "feishu"
    });
    return issue.id;
  }

  function linkFeishuProject(db: RunnerDatabase, projectID: string, chatID: string): void {
    const event = createExternalEvent(db, {
      content: "项目通知路由",
      dedupe_key: `feishu:message:project_${projectID}`,
      external_id: `om_project_${projectID}`,
      normalized_message: { chat_id: chatID, message_id: `om_project_${projectID}` },
      source: "feishu"
    });
    createExternalLink(db, {
      conversation_id: chatID,
      external_event_id: event.id,
      external_type: "feishu_agent_reply",
      project_id: projectID,
      relationship: "agent_reply",
      source: "feishu"
    });
  }

  function legacyPiActionIssue(db: RunnerDatabase, actionID: string): number {
    const issue = createIssue(db, { project_id: "demo", title: "Legacy PI task", status: "todo" });
    createPiAction(db, {
      action_type: "issue.enqueue",
      conversation_id: "feishu-chat-oc_group-20260614",
      id: actionID,
      issue_id: issue.id,
      project_id: "demo",
      source: "feishu_runner_chat",
      status: "completed"
    });
    return issue.id;
  }

  function expectSendNowIntent(
    intents: ReturnType<typeof listPiNotificationIntents>,
    input: { issueID: number; kind: string }
  ): void {
    expect(intents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        decision: "send_now",
        issue_id: input.issueID,
        kind: input.kind,
        run_group_id: "",
        state: "sent"
      })
    ]));
  }
  return { trackDatabase, tempRoots, fixtureDatabase, linkedFeishuIssue, linkFeishuProject, legacyPiActionIssue, expectSendNowIntent };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
