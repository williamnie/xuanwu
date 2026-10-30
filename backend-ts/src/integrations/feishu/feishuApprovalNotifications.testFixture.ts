import { afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createExternalEvent } from "../../db/repositories/externalEvents.ts";
import { createExternalLink } from "../../db/repositories/externalLinks.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { useDatabaseCleanup } from "../../testing/harness.ts";



export function createTestFixture() {
  const trackDatabase = useDatabaseCleanup();

  const tempRoots: string[] = [];

  afterEach(async () => {
    while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
  });

  async function fixtureDatabase(): Promise<RunnerDatabase> {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-feishu-approval-notify-"));
    tempRoots.push(root);
    const db = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
    db.sqlite.run(`insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?)`, [
      "demo", "Demo", join(root, "project"), "codex", '{"capabilities":["issue_execution"]}', 1,
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"
    ]);
    return db;
  }

  function linkedFeishuIssue(db: RunnerDatabase): number {
    const issue = createIssue(db, { project_id: "demo", title: "Feishu task", status: "triage" });
    const event = createExternalEvent(db, {
      content: "帮我修复问题",
      dedupe_key: "feishu:message:om_task",
      external_id: "om_task",
      normalized_message: { chat_id: "oc_group", message_id: "om_task" },
      source: "feishu"
    });
    createExternalLink(db, {
      conversation_id: "oc_group",
      external_event_id: event.id,
      external_type: "feishu_message",
      issue_id: issue.id,
      project_id: "demo",
      relationship: "created_issue",
      source: "feishu"
    });
    return issue.id;
  }

  function linkedTelegramIssue(db: RunnerDatabase): number {
    const issue = createIssue(db, { project_id: "demo", title: "Telegram task", status: "in_progress" });
    const event = createExternalEvent(db, {
      content: "需要授权",
      dedupe_key: "telegram:update:88",
      external_id: "88",
      normalized_message: {
        conversation: { id: "-100456", kind: "group" },
        message_id: "88",
        thread: { id: "12" }
      },
      provider: "telegram",
      source: "telegram"
    });
    createExternalLink(db, {
      conversation_id: "telegram-approval-conversation",
      external_event_id: event.id,
      external_type: "telegram_message",
      issue_id: issue.id,
      project_id: "demo",
      relationship: "origin",
      source: "telegram"
    });
    return issue.id;
  }

  function approvalEvent(id: string, threadId: string, command: string, turnId = "") {
    return {
      method: "approval/requested",
      payload: JSON.stringify({ id, params: { command, cwd: "/repo", threadId, turnId } }),
      provider: "codex",
      threadId,
      turnId,
      type: "codex.event"
    };
  }
  return { trackDatabase, tempRoots, fixtureDatabase, linkedFeishuIssue, linkedTelegramIssue, approvalEvent };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
