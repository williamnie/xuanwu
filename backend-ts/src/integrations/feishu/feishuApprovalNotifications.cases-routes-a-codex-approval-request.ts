import { expect, test } from "bun:test";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { listSyncOutbox } from "../../db/repositories/imReplyOutbox.ts";
import { listPiNotificationIntents, upsertPiApprovalRequest } from "../../db/repositories/pi.ts";
import { upsertAgentSession } from "../../db/repositories/agentSessions.ts";
import { EventBus } from "../../events/bus.ts";
import { flushAgentCommunicationTestMessages } from "../../notifications/agentCommunicationGateway.testSupport.ts";
import { buildFeishuConnectorConfig } from "./feishu.ts";
import { attachFeishuNotificationObservers, getPiApprovalRequest, listPiApprovalRequests, queueFeishuApprovalNotification, resolvePiApprovalRequestFromFeishu } from "./feishuNotifications.ts";
import type { TestFixture } from "./feishuApprovalNotifications.testFixture.ts";

export function registerRoutesACodexApprovalRequestCases(testScope: TestFixture) {
  const { fixtureDatabase, linkedFeishuIssue, linkedTelegramIssue, approvalEvent } = testScope;
  test("routes a Codex approval request to the linked Telegram conversation without Feishu config", async () => {
      const db = await fixtureDatabase();
      const issueID = linkedTelegramIssue(db);
      upsertAgentSession(db, {
        issue_id: issueID,
        project_id: "demo",
        provider: "codex",
        provider_session_id: "thread-telegram-approval"
      });
  
      const queued = queueFeishuApprovalNotification(
        db,
        approvalEvent("approval-telegram-1", "thread-telegram-approval", "git status"),
        { requireConfigured: true }
      );
      await flushAgentCommunicationTestMessages(db);
      const outbox = listSyncOutbox(db, { source: "telegram" });
  
      expect(queued).toMatchObject({ queued: true, reason: "queued" });
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({
        approval_action_id: "approval-telegram-1",
        target_chat_id: "-100456",
        target_message_id: "88",
        target_thread_id: "12"
      });
      expect(getPiApprovalRequest(db, "approval-telegram-1")).toMatchObject({
        delivery_channel: "telegram",
        delivery_state: "delivered"
      });
    });
  
  test("queues one Feishu notification when a linked issue session requests authorization", async () => {
      const db = await fixtureDatabase();
      const issueID = linkedFeishuIssue(db);
      upsertAgentSession(db, { issue_id: issueID, project_id: "demo", provider: "codex", provider_session_id: "thread-approval" });
  
      const first = queueFeishuApprovalNotification(db, approvalEvent("approval-1", "thread-approval", "git status"));
      const second = queueFeishuApprovalNotification(db, approvalEvent("approval-1", "thread-approval", "git status"));
      await flushAgentCommunicationTestMessages(db);
      const outbox = listSyncOutbox(db, { source: "feishu" });
      const content = outbox[0]?.content ?? "";
  
      expect(first).toMatchObject({ queued: true, reason: "queued" });
      expect(second).toMatchObject({ queued: false, reason: "duplicate" });
      expect(outbox).toHaveLength(1);
      expect(listPiNotificationIntents(db, { issueId: issueID })).toMatchObject([
        expect.objectContaining({
          kind: "approval_requested",
          requires_user: 1,
          sent_outbox_id: outbox[0]?.id,
          state: "sent"
        })
      ]);
      expect(content).toContain("git status");
      expect(outbox[0]).toMatchObject({
        approval_action_id: "approval-1",
        content: expect.stringContaining("#1「Feishu task」需要你确认"),
        issue_id: issueID,
        status: "pending",
        target_chat_id: "oc_group"
      });
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
  
  test("uses the project Feishu fallback for scoped destructive command approval", async () => {
      const db = await fixtureDatabase();
      const issue = createIssue(db, { project_id: "demo", title: "Local video cleanup", status: "in_progress" });
      upsertAgentSession(db, { issue_id: issue.id, project_id: "demo", provider: "codex", provider_session_id: "thread-rm" });
      const config = buildFeishuConnectorConfig({
        appId: "cli_fixture",
        appSecret: "fixture-secret",
        defaultChatId: "oc_default"
      });
  
      const queued = queueFeishuApprovalNotification(
        db,
        approvalEvent("approval-rm", "thread-rm", "rm -rf *.mp4"),
        { config, requireConfigured: true }
      );
      await flushAgentCommunicationTestMessages(db);
  
      expect(queued).toMatchObject({ queued: true });
      expect(listSyncOutbox(db, { source: "feishu" })).toEqual([
        expect.objectContaining({
          approval_action_id: "approval-rm",
          content: expect.stringContaining("rm -rf *.mp4"),
          target_chat_id: "oc_default"
        })
      ]);
    });
  
  test("records lifecycle, dispatches one IM notification, and resolves Codex from approval id", async () => {
      const db = await fixtureDatabase();
      const resolutions: Array<{ decision: string; id: string; scope: string }> = [];
      const issueID = linkedFeishuIssue(db);
      upsertAgentSession(db, { issue_id: issueID, project_id: "demo", provider: "codex", provider_session_id: "thread-record" });
  
      const first = queueFeishuApprovalNotification(
        db,
        approvalEvent("approval-record-1", "thread-record", "cat CODEX_API_KEY=fixture-secret /Users/example/private.txt", "turn-record")
      );
      const second = queueFeishuApprovalNotification(db, approvalEvent("approval-record-1", "thread-record", "git status"));
      await flushAgentCommunicationTestMessages(db);
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
        resolved_decision: "approve",
        resolved_scope: "turn"
      });
      expect(resolved).toMatchObject({ ok: true, status: "approved" });
      expect(duplicate).toMatchObject({ ok: true, status: "approved" });
      expect(resolutions).toEqual([{ decision: "approve", id: "approval-record-1", scope: "turn" }]);
    });
  
  test("returns expired approval callback status without resolving the provider", async () => {
      const db = await fixtureDatabase();
      const resolutions: Array<{ decision: string; id: string; scope: string }> = [];
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
    });
}
