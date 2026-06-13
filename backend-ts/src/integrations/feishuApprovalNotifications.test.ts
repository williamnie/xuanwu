import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { createExternalLink } from "../db/repositories/externalLinks.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { listSyncOutbox } from "../db/repositories/imReplyOutbox.ts";
import { upsertPiApprovalRequest } from "../db/repositories/pi.ts";
import { upsertAgentSession } from "../db/repositories/agentSessions.ts";
import { updateIssue } from "../db/repositories/issueUpdate.ts";
import { EventBus } from "../events/bus.ts";
import { buildFeishuConnectorConfig } from "./feishu.ts";
import {
  attachFeishuNotificationObservers,
  getPiApprovalRequest,
  listPiApprovalRequests,
  queueFeishuApprovalNotification,
  resolvePiApprovalRequestFromFeishu
} from "./feishuNotifications.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
});

describe("Feishu approval notification queue", () => {
  test("queues one Feishu notification when a linked issue session requests authorization", async () => {
    const db = await fixtureDatabase();
    try {
      const issueID = linkedFeishuIssue(db);
      upsertAgentSession(db, { issue_id: issueID, project_id: "demo", provider: "codex", provider_session_id: "thread-approval" });

      const first = queueFeishuApprovalNotification(db, approvalEvent("approval-1", "thread-approval", "git status"));
      const second = queueFeishuApprovalNotification(db, approvalEvent("approval-1", "thread-approval", "git status"));
      const outbox = listSyncOutbox(db, { source: "feishu" });
      const content = outbox[0]?.content ?? "";

      expect(first).toMatchObject({ queued: true, reason: "queued" });
      expect(second).toMatchObject({ queued: false, reason: "duplicate" });
      expect(outbox).toHaveLength(1);
      expect(content).toContain("git status");
      expect(outbox[0]).toMatchObject({
        approval_action_id: "approval-1",
        content: expect.stringContaining("issue #1 需要 Codex 授权"),
        issue_id: issueID,
        status: "pending",
        target_chat_id: "oc_group"
      });
    } finally {
      db.close();
    }
  });

  test("keeps approval pending without an outbox notification when Feishu is not configured", async () => {
    const db = await fixtureDatabase();
    const bus = new EventBus();
    const detach = attachFeishuNotificationObservers({ bus, database: db });
    try {
      const issueID = linkedFeishuIssue(db);
      upsertAgentSession(db, { issue_id: issueID, project_id: "demo", provider: "codex", provider_session_id: "thread-disabled" });

      bus.publish(approvalEvent("approval-disabled-1", "thread-disabled", "bun test"));

      expect(listSyncOutbox(db, { source: "feishu" })).toHaveLength(0);
      expect(getPiApprovalRequest(db, "approval-disabled-1")).toMatchObject({
        approval_id: "approval-disabled-1",
        delivery_state: "pending",
        status: "pending"
      });
    } finally {
      detach();
      db.close();
    }
  });

  test("records lifecycle, dispatches one IM notification, and resolves Codex from approval id", async () => {
    const db = await fixtureDatabase();
    const resolutions: Array<{ decision: string; id: string; scope: string }> = [];
    try {
      const issueID = linkedFeishuIssue(db);
      upsertAgentSession(db, { issue_id: issueID, project_id: "demo", provider: "codex", provider_session_id: "thread-record" });

      const first = queueFeishuApprovalNotification(
        db,
        approvalEvent("approval-record-1", "thread-record", "cat CODEX_API_KEY=fixture-secret /Users/example/private.txt", "turn-record")
      );
      const second = queueFeishuApprovalNotification(db, approvalEvent("approval-record-1", "thread-record", "git status"));
      const resolved = await resolvePiApprovalRequestFromFeishu(db, {
        decision: "approve_session",
        provider: { resolveApproval: async (id, decision) => { resolutions.push({ id, decision: decision.decision, scope: decision.scope ?? "" }); } },
        requestID: "approval-record-1",
        scope: "session"
      });
      const duplicate = await resolvePiApprovalRequestFromFeishu(db, {
        decision: "deny",
        provider: { resolveApproval: async (id, decision) => { resolutions.push({ id, decision: decision.decision, scope: decision.scope ?? "" }); } },
        requestID: "approval-record-1",
        scope: "turn"
      });
      const outbox = listSyncOutbox(db, { source: "feishu" });
      const requests = listPiApprovalRequests(db);

      expect(first).toMatchObject({ queued: true, reason: "queued" });
      expect(second).toMatchObject({ queued: false, reason: "duplicate" });
      expect(outbox[0]?.content).toContain("[redacted-path]");
      expect(outbox[0]?.content).not.toContain("fixture-secret");
      expect(outbox[0]?.content).not.toContain("/Users/example");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        approval_id: "approval-record-1",
        delivery_channel: "feishu",
        issue_id: issueID,
        provider: "codex",
        request_type: "command",
        status: "approved",
        thread_id: "thread-record",
        turn_id: "turn-record"
      });
      expect(getPiApprovalRequest(db, "approval-record-1")).toMatchObject({
        resolved_decision: "approve_session",
        resolved_scope: "session"
      });
      expect(resolved).toMatchObject({ ok: true, status: "approved" });
      expect(duplicate).toMatchObject({ ok: true, status: "approved" });
      expect(resolutions).toEqual([{ decision: "approve_session", id: "approval-record-1", scope: "session" }]);
    } finally {
      db.close();
    }
  });

  test("returns expired approval callback status without resolving the provider", async () => {
    const db = await fixtureDatabase();
    const resolutions: Array<{ decision: string; id: string; scope: string }> = [];
    try {
      upsertPiApprovalRequest(db, {
        approval_id: "approval-expired-1",
        approval_source: "codex_provider_event",
        issue_id: 392,
        project_id: "demo",
        provider: "codex",
        provider_approval_id: "approval-expired-1",
        request_summary: "command=bun test",
        request_type: "command",
        status: "expired",
        thread_id: "thread-expired"
      });

      const result = await resolvePiApprovalRequestFromFeishu(db, {
        decision: "approve",
        provider: { resolveApproval: async (id, decision) => { resolutions.push({ id, decision: decision.decision, scope: decision.scope ?? "" }); } },
        requestID: "approval-expired-1",
        scope: "turn"
      });

      expect(result).toEqual({ ok: true, status: "expired" });
      expect(resolutions).toEqual([]);
      expect(getPiApprovalRequest(db, "approval-expired-1")).toMatchObject({
        resolved_decision: "",
        status: "expired"
      });
    } finally {
      db.close();
    }
  });

  test("observer queues approval notification and records resolved provider event", async () => {
    const db = await fixtureDatabase();
    const bus = new EventBus();
    const detach = attachFeishuNotificationObservers({
      bus,
      config: buildFeishuConnectorConfig({ appId: "cli_app_id", appSecret: "app-secret-value" }),
      database: db,
      sender: {
        sendTextMessage: async () => ({ messageId: "om_sent_text" }),
        sendInteractiveCard: async () => ({ messageId: "om_sent_card" })
      }
    });
    try {
      const issueID = linkedFeishuIssue(db);
      upsertAgentSession(db, { issue_id: issueID, project_id: "demo", provider: "codex", provider_session_id: "thread-observed" });
      updateIssue(db, issueID, { status: "done", error: "" });

      bus.publish({ issueId: issueID, payload: JSON.stringify({ status: "done" }), type: "issue.status_changed" });
      bus.publish(approvalEvent("approval-observed", "thread-observed", "bun test"));
      bus.publish({
        method: "approval/resolved",
        payload: JSON.stringify({ decision: "deny", id: "approval-observed", scope: "turn" }),
        provider: "codex",
        threadId: "thread-observed",
        type: "codex.event"
      });

      const outbox = listSyncOutbox(db, { source: "feishu" });
      expect(outbox).toHaveLength(2);
      expect(outbox.map((item) => item.content).join("\n")).toContain("issue #1 已完成");
      expect(outbox.map((item) => item.content).join("\n")).toContain("bun test");
      expect(getPiApprovalRequest(db, "approval-observed")).toMatchObject({ resolved_decision: "deny", status: "rejected" });
    } finally {
      detach();
      db.close();
    }
  });
});

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-approval-notify-"));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
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
