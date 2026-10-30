import { afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createExternalEvent } from "../../db/repositories/externalEvents.ts";
import { createExternalLink } from "../../db/repositories/externalLinks.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { createPiMemoryItem } from "../../db/repositories/pi.ts";
import type { ExecutorProvider, ProviderRunInput } from "../../providers/types.ts";



export function createTestFixture() {
  const tempRoots: string[] = [];

  afterEach(async () => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true });
    }
  });

  async function fixtureDatabase(provider = "codex"): Promise<RunnerDatabase> {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-feishu-lifecycle-"));
    tempRoots.push(root);
    const db = await openDatabase({ stateDir: join(root, "state") });
    db.sqlite.run(
      `insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["demo", "Demo", join(root, "project"), provider, '{"capabilities":["issue_execution"]}', 1,
        "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
    );
    return db;
  }

  function failingProvider(): ExecutorProvider {
    return {
      id: "fake-execution-only",
      capabilities: ["issue_execution"],
      async run(input: ProviderRunInput) {
        input.onEvent?.({
          provider: "fake-execution-only",
          session: { provider: "fake-execution-only", sessionId: "thread-fail", turnId: "turn-fail" },
          status: "running",
          type: "provider.message"
        });
        throw new Error("provider failed");
      }
    };
  }

  function linkedFeishuIssue(db: RunnerDatabase, input: { conversationID?: string } = {}): number {
    const issue = createIssue(db, { project_id: "demo", title: "Feishu task", status: "triage" });
    const event = createExternalEvent(db, {
      content: "帮我修复问题",
      dedupe_key: "feishu:message:om_task",
      external_id: "om_task",
      normalized_message: { chat_id: "oc_group", message_id: "om_task" },
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

  function linkedTelegramIssue(db: RunnerDatabase): number {
    const issue = createIssue(db, { project_id: "demo", title: "Telegram task", status: "triage" });
    const feishuProjectEvent = createExternalEvent(db, {
      content: "project fallback",
      dedupe_key: "feishu:project-fallback",
      external_id: "om_project_fallback",
      normalized_message: { chat_id: "oc_project_fallback", message_id: "om_project_fallback" },
      source: "feishu"
    });
    createExternalLink(db, {
      conversation_id: "oc_project_fallback",
      external_event_id: feishuProjectEvent.id,
      external_type: "feishu_message",
      project_id: "demo",
      relationship: "notification",
      source: "feishu"
    });
    const event = createExternalEvent(db, {
      content: "处理 Telegram 任务",
      dedupe_key: "telegram:update:77",
      external_id: "77",
      normalized_message: {
        conversation: { id: "-100123", kind: "group" },
        message_id: "77",
        thread: { id: "9" }
      },
      provider: "telegram",
      source: "telegram"
    });
    createExternalLink(db, {
      conversation_id: "telegram-conversation",
      external_event_id: event.id,
      external_type: "telegram_message",
      issue_id: issue.id,
      project_id: "demo",
      relationship: "created_issue",
      source: "telegram"
    });
    return issue.id;
  }

  function createCandidate(db: RunnerDatabase, id: string, content: string): void {
    createPiMemoryItem(db, {
      id,
      scope: "project",
      scope_id: "demo",
      kind: "user_preference",
      content,
      source_type: "pi.conversation",
      source_id: "feishu-chat-oc_group-20260614",
      disabled: 1
    });
  }

  function memoryCandidateEvent(id: string) {
    return {
      conversationId: "feishu-chat-oc_group-20260614",
      payload: JSON.stringify({ id, kind: "user_preference", scope: "project", scope_id: "demo" }),
      projectId: "demo",
      type: "pi.memory_candidate"
    };
  }
  return { tempRoots, fixtureDatabase, failingProvider, linkedFeishuIssue, linkedTelegramIssue, createCandidate, memoryCandidateEvent };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
