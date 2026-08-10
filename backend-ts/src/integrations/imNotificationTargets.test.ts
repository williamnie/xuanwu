import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { createExternalLink } from "../db/repositories/externalLinks.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { resolveImNotificationTarget } from "./imNotificationTargets.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("generic IM notification target resolver", () => {
  test("resolves canonical Telegram ids as opaque strings from shared external facts", async () => {
    const db = await fixture();
    try {
      const issue = createIssue(db, { project_id: "demo", status: "todo", title: "Telegram source" });
      const event = createExternalEvent(db, {
        content: "hello",
        dedupe_key: "telegram:update-1",
        external_id: "message-9",
        normalized_message: {
          conversation: { id: "-100opaque", kind: "group" },
          message_id: "message-9",
          thread: { id: "topic-4" }
        },
        provider: "telegram",
        source: "telegram"
      });
      createExternalLink(db, {
        conversation_id: "internal-conversation",
        external_event_id: event.id,
        external_id: "message-9",
        external_type: "im_message",
        issue_id: issue.id,
        project_id: "demo",
        relationship: "origin",
        source: "telegram"
      });

      expect(resolveImNotificationTarget(db, { connectorID: "telegram", issueID: issue.id })).toEqual({
        connector_id: "telegram",
        conversation_id: "-100opaque",
        external_event_id: event.id,
        reply_to_message_id: "message-9",
        thread_id: "topic-4"
      });
      expect(resolveImNotificationTarget(db, { connectorID: "feishu", issueID: issue.id })).toBeNull();
    } finally { db.close(); }
  });

  test("fails closed when the linked event belongs to another connector", async () => {
    const db = await fixture();
    try {
      const event = createExternalEvent(db, {
        content: "cross source",
        dedupe_key: "feishu:event-1",
        normalized_message: { conversation: { id: "oc_secret", kind: "group" }, message_id: "m1" },
        provider: "feishu",
        source: "feishu"
      });
      db.sqlite.run(`insert into external_links
        (source, external_type, external_id, external_event_id, project_id, issue_id,
         conversation_id, loop_run_id, relationship, created_at, updated_at)
        values ('telegram', 'im_message', 'm1', ?, 'demo', 0, 'conv', '', 'origin', ?, ?)`, [
        event.id, "2026-08-10T00:00:00Z", "2026-08-10T00:00:00Z"
      ]);
      expect(resolveImNotificationTarget(db, {
        connectorID: "telegram",
        conversationID: "conv"
      })).toBeNull();
    } finally { db.close(); }
  });
});

async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "im-notification-target-"));
  roots.push(root);
  const db = await openDatabase({ stateDir: root });
  db.sqlite.run(`insert into projects (id, name, cwd, provider, created_at, updated_at)
    values ('demo', 'Demo', '/tmp/demo', 'fake-execution-only', ?, ?)`, [
    "2026-08-10T00:00:00Z", "2026-08-10T00:00:00Z"
  ]);
  return db;
}
