import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../config/env.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { createExternalLink } from "../db/repositories/externalLinks.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { getSyncOutbox, listSyncOutbox } from "../db/repositories/imReplyOutbox.ts";
import { createPiAction, getPiAction, listPiActionEvents, listPiNotificationIntents } from "../db/repositories/pi.ts";
import { createDefaultRouter, createRequestHandler } from "../http/server.ts";
import { flushAgentCommunicationTestMessages } from "../notifications/agentCommunicationGateway.testSupport.ts";
import { dispatchFeishuOutbox, type FeishuMessageSender } from "../pi/imReplyOutboxDispatcher.ts";
import { queueFeishuPiActionPendingNotification, queuePendingPiActionNotifications } from "./feishuNotifications.ts";

const tempRoots: string[] = [];
const BASE_URL = "http://127.0.0.1:3008";

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
});

describe("Feishu PI action cards", () => {
  test("dispatches pending PI action notifications as an interactive card", async () => {
    const db = await fixtureDatabase();
    const sender = new FakeFeishuSender();
    try {
      const issueID = linkedFeishuIssue(db);
      createPendingPiAction(db, "pi-action-card-1", issueID);

      const queued = queueFeishuPiActionPendingNotification(db, {
        issueId: issueID,
        payload: JSON.stringify({ action_id: "pi-action-card-1", action_type: "issue.comment", status: "pending" }),
        projectId: "demo",
        type: "pi.action_pending"
      });
      await flushAgentCommunicationTestMessages(db);
      const outbox = listSyncOutbox(db, { source: "feishu" })[0];
      const dispatched = await dispatchFeishuOutbox({
        config: buildConfig({ feishuAllowedChatIds: "oc_group" }).integrations.feishu,
        database: db,
        sender
      });
      const cardText = JSON.stringify(sender.cardCalls[0]?.card ?? {});

      expect(queued).toMatchObject({ queued: true, reason: "queued" });
      expect(outbox).toMatchObject({ approval_action_id: "pi_action:pi-action-card-1" });
      expect(dispatched).toMatchObject({ failed: 0, sent: 1 });
      expect(sender.calls).toEqual([]);
      expect(cardText).toContain("pi-action-card-1");
      expect(cardText).toContain("批准执行");
      expect(cardText).not.toContain("当前项目始终允许");
      expect(cardText).toContain("拒绝");
      expect(cardText).toContain("要求修改");
      expect(cardText).toContain("暂缓 30 分钟");
      expect(getSyncOutbox(db, outbox.id)).toMatchObject({ feishu_message_id: "om_card_1", status: "sent" });
    } finally {
      db.close();
    }
  });

  test("uses the project Feishu fallback and persists an explicit failure when no target exists", async () => {
    const db = await fixtureDatabase();
    const sender = new FakeFeishuSender();
    try {
      createPiAction(db, { action_type: "mcp.tool.call", gate_decision: "ask", id: "mcp-push", project_id: "demo", status: "pending" });
      const event = {
        payload: JSON.stringify({ action_id: "mcp-push", action_type: "mcp.tool.call" }),
        projectId: "demo",
        type: "pi.action_pending"
      };
      const missing = queueFeishuPiActionPendingNotification(db, event);
      expect(missing).toEqual({ queued: false, reason: "missing_feishu_target" });
      expect(listPiNotificationIntents(db)).toEqual([
        expect.objectContaining({ error: "missing_feishu_target", source_event_id: "mcp-push", state: "failed" })
      ]);

      const queued = queueFeishuPiActionPendingNotification(db, event, {
        config: buildConfig({ feishuDefaultChatId: "oc_default" }).integrations.feishu
      });
      await flushAgentCommunicationTestMessages(db);
      expect(queued).toMatchObject({ queued: true });
      expect(listSyncOutbox(db, { source: "feishu" })).toEqual([
        expect.objectContaining({ approval_action_id: "pi_action:mcp-push", target_chat_id: "oc_default" })
      ]);
      await dispatchFeishuOutbox({
        config: buildConfig({ feishuDefaultChatId: "oc_default" }).integrations.feishu,
        database: db,
        sender
      });
      expect(JSON.stringify(sender.cardCalls[0]?.card)).toContain("当前项目始终允许");
    } finally { db.close(); }
  });

  test("sweeps pending Actions created without an in-process event observer into Feishu", async () => {
    const db = await fixtureDatabase();
    try {
      createPiAction(db, {
        action_type: "assistant.tool.call",
        gate_decision: "ask",
        id: "skill-write-action",
        payload_json: JSON.stringify({
          input: { path: "notes/output.txt" },
          permission: "write",
          provider_id: "fixture-cli",
          tool_name: "write-file"
        }),
        project_id: "demo",
        source: "skill_runtime:fixture",
        status: "pending"
      });
      const result = queuePendingPiActionNotifications(
        db,
        buildConfig({ feishuDefaultChatId: "oc_default" }).integrations.feishu
      );
      await flushAgentCommunicationTestMessages(db);

      expect(result).toMatchObject({ queued: 1, scanned: 1 });
      expect(listSyncOutbox(db, { source: "feishu" })).toEqual([
        expect.objectContaining({
          approval_action_id: "pi_action:skill-write-action",
          content: expect.stringContaining("目标 fixture-cli:write-file；权限 write；输入"),
          target_chat_id: "oc_default"
        })
      ]);
    } finally { db.close(); }
  });

  test("resolves approve PI action callbacks through the action dispatcher", async () => {
    const { database, handle } = await fixtureHandler();
    try {
      const issue = createIssue(database, { project_id: "demo", status: "triage", title: "PI action target" });
      createPendingPiAction(database, "pi-action-callback-approve", issue.id, "Approved from Feishu");

      const first = await postFeishu(handle, piActionCallback("pi-action-callback-approve", "approve"));
      const replay = await postFeishu(handle, piActionCallback("pi-action-callback-approve", "reject"));

      expect(first.status).toBe(202);
      expect(await first.json()).toMatchObject({ ok: true, status: "completed" });
      expect(replay.status).toBe(202);
      expect(await replay.json()).toMatchObject({ ok: true, status: "completed" });
      expect(getPiAction(database, "pi-action-callback-approve")).toMatchObject({
        approved_by: "feishu:ou_user_1",
        status: "completed"
      });
      expect(listIssueEvents(database, issue.id).map((event) => event.type)).toContain("issue.comment");
    } finally {
      database.close();
    }
  });

  test("supports request changes, reject, and snooze PI action callbacks", async () => {
    const { database, handle } = await fixtureHandler();
    try {
      const issue = createIssue(database, { project_id: "demo", status: "triage", title: "PI action target" });
      createPendingPiAction(database, "pi-action-changes", issue.id);
      createPendingPiAction(database, "pi-action-reject", issue.id);
      createPendingPiAction(database, "pi-action-snooze", issue.id);

      const changes = await postFeishu(handle, piActionCallback("pi-action-changes", "request_changes"));
      const rejected = await postFeishu(handle, piActionCallback("pi-action-reject", "reject"));
      const snoozed = await postFeishu(handle, piActionCallback("pi-action-snooze", "snooze", { snoozeMinutes: 30 }));

      expect(changes.status).toBe(202);
      expect(rejected.status).toBe(202);
      expect(snoozed.status).toBe(202);
      expect(await changes.json()).toMatchObject({ ok: true, status: "changes_requested" });
      expect(await rejected.json()).toMatchObject({ ok: true, status: "rejected" });
      expect(await snoozed.json()).toMatchObject({ ok: true, status: "snoozed" });
      expect(getPiAction(database, "pi-action-changes")).toMatchObject({
        decided_by: "feishu:ou_user_1",
        requested_changes: expect.stringContaining("Feishu")
      });
      expect(getPiAction(database, "pi-action-reject")).toMatchObject({
        decided_by: "feishu:ou_user_1",
        status: "rejected"
      });
      expect(getPiAction(database, "pi-action-snooze")).toMatchObject({
        decided_by: "feishu:ou_user_1",
        gate_decision: "snooze",
        snoozed_until: expect.any(String)
      });
      expect(listPiActionEvents(database, { actionId: "pi-action-changes" }).map((event) => event.event_type))
        .toContain("approval_decision");
    } finally {
      database.close();
    }
  });

  test("rejects PI action callbacks from unauthorized Feishu chats", async () => {
    const { database, handle } = await fixtureHandler({ allowedChatIds: "oc_allowed" });
    try {
      const issue = createIssue(database, { project_id: "demo", status: "triage", title: "PI action target" });
      createPendingPiAction(database, "pi-action-denied-chat", issue.id);

      const response = await postFeishu(
        handle,
        piActionCallback("pi-action-denied-chat", "approve", { chatId: "oc_denied" })
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ message: "feishu approval callback is not allowed" });
      expect(getPiAction(database, "pi-action-denied-chat")).toMatchObject({ status: "pending" });
    } finally {
      database.close();
    }
  });
});

async function fixtureHandler(options: { allowedChatIds?: string; allowedUserIds?: string } = {}) {
  const database = await fixtureDatabase();
  const config = buildConfig({
    feishuAllowedChatIds: options.allowedChatIds,
    feishuAllowedUserIds: options.allowedUserIds,
    feishuAppId: "cli_app_id",
    feishuAppSecret: "app-secret-value",
    feishuVerificationToken: "verify-token"
  });
  const router = createDefaultRouter({ config, database });
  return { database, handle: createRequestHandler(router, "") };
}

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-pi-action-card-"));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["demo", "Demo", join(root, "project"), "codex", '{"capabilities":["issue_execution"]}', 1,
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
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

function createPendingPiAction(db: RunnerDatabase, id: string, issueID: number, body?: string): void {
  createPiAction(db, {
    action_type: "issue.comment",
    gate_decision: "ask",
    id,
    issue_id: issueID,
    payload_json: JSON.stringify({ body: body ?? `body for ${id}`, issue_id: issueID }),
    project_id: "demo",
    requires_confirmation: 1,
    risk_level: "medium",
    status: "pending"
  });
}

async function postFeishu(handle: (request: Request) => Promise<Response>, body: unknown): Promise<Response> {
  return handle(new Request(`${BASE_URL}/api/integrations/feishu/events`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  }));
}

function piActionCallback(
  actionID: string,
  decision: string,
  options: { chatId?: string; snoozeMinutes?: number; userId?: string; userOpenId?: string } = {}
): Record<string, unknown> {
  return {
    header: { event_id: `event-${actionID}-${decision}`, event_type: "card.action.trigger", token: "verify-token" },
    event: {
      action: { value: { action: "pi_action_resolve", action_id: actionID, comment: "Needs changes from Feishu", decision, snooze_minutes: options.snoozeMinutes } },
      context: { open_chat_id: options.chatId ?? "oc_group", open_message_id: `om_${actionID}` },
      operator: { operator_id: { open_id: options.userOpenId ?? "ou_open_1", user_id: options.userId ?? "ou_user_1" } }
    },
    schema: "2.0"
  };
}

class FakeFeishuSender implements FeishuMessageSender {
  calls: Array<{ receiveId: string; receiveIdType: string; text: string }> = [];
  cardCalls: Array<{ card: Record<string, unknown>; receiveId: string; receiveIdType: string }> = [];

  async sendInteractiveCard(input: {
    card: Record<string, unknown>;
    receiveId: string;
    receiveIdType: string;
  }): Promise<{ messageId: string }> {
    this.cardCalls.push(input);
    return { messageId: `om_card_${this.cardCalls.length}` };
  }

  async sendTextMessage(input: { receiveId: string; receiveIdType: string; text: string }): Promise<{ messageId: string }> {
    this.calls.push(input);
    return { messageId: `om_text_${this.calls.length}` };
  }
}
