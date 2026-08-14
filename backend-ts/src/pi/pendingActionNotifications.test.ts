import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { createExternalLink } from "../db/repositories/externalLinks.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { createPiAction, listPiNotificationIntents } from "../db/repositories/pi.ts";
import { queuePendingImActionNotifications } from "./pendingActionNotifications.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("pending IM action notification sweep", () => {
  test("routes a pending action to the connector recovered from shared IM facts", async () => {
    const db = await fixture();
    try {
      const issue = createIssue(db, { project_id: "demo", status: "in_progress", title: "Approve Telegram action" });
      const event = createExternalEvent(db, {
        content: "run tool",
        dedupe_key: "telegram:action-source",
        external_id: "message-1",
        normalized_message: {
          conversation: { id: "-100opaque", kind: "group" },
          message_id: "message-1",
          sender: { id: "user-7", kind: "user" }
        },
        provider: "telegram",
        source: "telegram"
      });
      createExternalLink(db, {
        conversation_id: "conversation-telegram",
        external_event_id: event.id,
        issue_id: issue.id,
        relationship: "origin",
        source: "telegram"
      });
      createPiAction(db, {
        action_type: "mcp.tool.call",
        conversation_id: "conversation-telegram",
        id: "action-telegram",
        issue_id: issue.id,
        payload_json: { provider_id: "mcp", tool_name: "write" },
        project_id: "demo",
        status: "pending"
      });
      createPiAction(db, {
        action_type: "mcp.tool.call",
        id: "stale-actionable-action",
        payload_json: { output: "y".repeat(32_000) },
        project_id: "demo",
        status: "pending"
      });
      db.sqlite.run("update pi_actions set created_at='2026-08-01T00:00:00Z' where id='stale-actionable-action'");

      expect(queuePendingImActionNotifications(db)).toMatchObject({ failed: 0, queued: 1, scanned: 1 });
      expect(listPiNotificationIntents(db, { kind: "pi_action_pending" })).toMatchObject([{
        source_event_id: "action-telegram",
        state: "agent_pending",
        target_channel: "telegram",
        target_chat_id: "-100opaque",
        target_message_id: "message-1"
      }]);
    } finally { db.close(); }
  });

  test("does not materialize stale or unrelated pending action payloads", async () => {
    const db = await fixture();
    try {
      createPiAction(db, {
        action_type: "run.interrupt",
        created_at: "2026-08-01T00:00:00Z",
        id: "stale-unrelated-action",
        payload_json: { output: "x".repeat(32_000) },
        project_id: "demo",
        status: "pending"
      });

      expect(queuePendingImActionNotifications(db, {
        now: new Date("2026-08-12T00:00:00Z")
      })).toEqual({ failed: 0, queued: 0, scanned: 0, skipped: 0 });
    } finally { db.close(); }
  });
});

async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "pending-im-action-"));
  roots.push(root);
  const db = await openDatabase({ stateDir: root });
  db.sqlite.run(`insert into projects (id, name, cwd, provider, created_at, updated_at)
    values ('demo', 'Demo', '/tmp/demo', 'fake-execution-only', ?, ?)`, [
    "2026-08-10T00:00:00Z", "2026-08-10T00:00:00Z"
  ]);
  return db;
}
