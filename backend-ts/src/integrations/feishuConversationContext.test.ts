import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { approveImReplyDraft, createImReplyDraft } from "../db/repositories/imReplyOutbox.ts";
import { markSyncOutboxSent } from "../db/repositories/imReplyOutboxDispatch.ts";
import type { FeishuNormalizedMessageEvent } from "./feishu.ts";
import { buildFeishuConversationPromptContext } from "./feishuConversationContext.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Feishu bounded conversation projection", () => {
  test("merges recent inbound messages and sent notifications without including the current message", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo", "Demo");
      const issue = createIssue(db, { project_id: "demo", status: "todo", title: "Verify memory" });
      saveInbound(db, "om_old", "之前说的是 #" + issue.id, "2026-07-21T01:00:00.000Z");
      saveInbound(db, "om_current", "验收", "2026-07-21T04:00:00.000Z");
      saveSentNotification(db, issue.id, "issue #" + issue.id + " 已完成，请回复：验收 / 需复查 API_KEY=secret-value", "2026-07-21T03:00:00.000Z");

      const current = eventFixture({ message_id: "om_current", text: "验收" });
      const context = buildFeishuConversationPromptContext(db, { event: current });

      expect(context).toContain("inbound");
      expect(context).toContain("outbound issue=#" + issue.id);
      expect(context).toContain("之前说的是 #" + issue.id);
      expect(context).not.toContain("message=om_current");
      expect(context).not.toContain("secret-value");
    } finally {
      db.close();
    }
  });

  test("keeps prior notification context without classifying the current message", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo", "Demo");
      const issue = createIssue(db, { project_id: "demo", status: "todo", title: "Continue exact work" });
      saveSentNotification(db, issue.id, "issue #" + issue.id + " 待验收", "2026-07-21T03:00:00.000Z");
      const event = eventFixture({ text: "验收" });

      const context = buildFeishuConversationPromptContext(db, { event });
      expect(context).toContain(`outbound issue=#${issue.id}`);
      expect(context).toContain("待验收");
      expect(context).not.toContain("active_reply_target");
    } finally {
      db.close();
    }
  });

  test("keeps the previous inbound target visible for PI to interpret a follow-up", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo", "Demo");
      const issue = createIssue(db, { project_id: "demo", status: "failed", title: "Retry exact work" });
      saveInbound(db, "om_previous", `需要补充什么上下文？如何重试${issue.id}呢`, "2026-07-21T03:59:00.000Z");
      const current = eventFixture({ text: "重试吧" });

      const context = buildFeishuConversationPromptContext(db, { event: current });
      expect(context).toContain(`如何重试${issue.id}呢`);
      expect(context).not.toContain("active_reply_target");
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-feishu-context-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string, name: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [id, name, `/tmp/${id}`, "2026-07-21T00:00:00.000Z", "2026-07-21T00:00:00.000Z"]
  );
}

function saveInbound(db: RunnerDatabase, messageID: string, content: string, timestamp: string): void {
  createExternalEvent(db, {
    content,
    dedupe_key: `feishu:message:${messageID}`,
    external_id: messageID,
    normalized_message: { chat_id: "oc_group", message_id: messageID, root_id: "", thread_id: "" },
    occurred_at: timestamp,
    source: "feishu"
  }, new Date(timestamp));
}

function saveSentNotification(db: RunnerDatabase, issueID: number, content: string, timestamp: string): void {
  const draft = createImReplyDraft(db, {
    content,
    created_by: "notification_writer",
    issue_id: issueID,
    source: "feishu",
    target_chat_id: "oc_group"
  }, new Date(timestamp));
  const { outbox } = approveImReplyDraft(db, draft.id, new Date(timestamp));
  markSyncOutboxSent(db, outbox.id, {
    feishuMessageId: `om_notification_${issueID}`,
    timestamp: new Date(timestamp)
  });
}

function eventFixture(overrides: Partial<FeishuNormalizedMessageEvent> = {}): FeishuNormalizedMessageEvent {
  return {
    attachments: [],
    chat_id: "oc_group",
    chat_type: "group",
    dedupe_key: "feishu:message:om_current",
    mentions: [],
    message_id: "om_current",
    raw_event_ref: "",
    root_id: "",
    sender: { id: "ou_user", open_id: "ou_open", tenant_key: "tenant", type: "user" },
    source_id: "feishu:message:om_current",
    text: "验收",
    thread_id: "",
    timestamp: "2026-07-21T04:00:00.000Z",
    ...overrides
  };
}
