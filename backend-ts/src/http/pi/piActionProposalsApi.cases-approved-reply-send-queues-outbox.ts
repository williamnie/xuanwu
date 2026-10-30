import { expect, test } from "bun:test";
import { getAttentionInboxItem } from "../../db/repositories/intakeRuns.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { listIssues } from "../../db/repositories/issues.ts";
import { getAutomation, getAutomationTrigger } from "../../db/repositories/automations.ts";
import { listImReplyDrafts, listSyncOutbox } from "../../db/repositories/imReplyOutbox.ts";
import { getPiAction, getPiIssueCompletionWatch, listPiMemoryItems } from "../../db/repositories/pi.ts";
import { createDefaultRouter } from "../server.ts";
import type { TestFixture } from "./piActionProposalsApi.testFixture.ts";

export function registerApprovedReplySendQueuesOutboxCases(testScope: TestFixture) {
  const { openFixtureDatabase, action, seedProject, seedBugReport, seedReplyEvent, sourcePolicyReason, jsonRequest } = testScope;
  test("approved reply_send queues outbox only when auto reply policy is enabled", async () => {
      const db = await openFixtureDatabase();
      const eventID = seedReplyEvent(db);
      const router = createDefaultRouter({ database: db });
      const proposal = await jsonRequest(router, "/api/pi/action-proposals", {
        body: JSON.stringify({
          actions: [
            action("message.reply_send", {
              reply_policy: { allowed_chats: ["oc_reply_chat"], auto_reply_enabled: true },
              source: "fixture-im",
              text: "可以发送"
            }, "low", false)
          ],
          evidence_refs: [`external_event:${eventID}`],
          skill_run_id: "domain-run-send",
          source_item_ids: ["attention_inbox_item:999"],
          summary: "允许自动回复的低风险发送。",
          target_hints: []
        }),
        method: "POST"
      });
  
      const approved = await jsonRequest(router, `/api/pi/action-proposals/${proposal.id}/approve`, {
        body: JSON.stringify({ actor: "tester" }),
        method: "POST"
      });
  
      expect(approved.actions[0]).toMatchObject({ execution_status: "completed", type: "message.reply_send" });
      expect(getPiAction(db, approved.actions[0].pi_action_id)).toMatchObject({
        gate_decision: "execute",
        requires_confirmation: 0
      });
      expect(sourcePolicyReason(db, approved.actions[0].pi_action_id)).toBe("low_risk_auto_reply_allowed");
      expect(listImReplyDrafts(db, { source: "fixture-im" })).toMatchObject([
        expect.objectContaining({ content: "可以发送", status: "approved" })
      ]);
      expect(listSyncOutbox(db, { source: "fixture-im" })).toMatchObject([
        expect.objectContaining({ content: "可以发送", status: "pending" })
      ]);
    });
  
  test("approving non-issue proposal actions terminalizes into traceable records", async () => {
      const db = await openFixtureDatabase();
      seedProject(db, "demo");
      const itemID = seedBugReport(db);
      const watched = createIssue(db, { project_id: "demo", status: "todo", title: "Watched task" });
      const router = createDefaultRouter({ database: db });
  
      const proposal = await jsonRequest(router, "/api/pi/action-proposals", {
        body: JSON.stringify({
          actions: [
            action("ask_user", { question: "要把这个提醒发到群里吗？" }, "low", false),
            action("watch_thread", {
              issue_ids: [watched.id],
              project_id: "demo",
              target_channel: "telegram",
              target_chat_id: "oc_watch"
            }, "low", false),
            action("reminder.create", {
              due_at: "2999-01-01T00:00:00Z",
              summary: "到点检查是否需要继续跟进",
              title: "跟进提醒"
            }, "low", false),
            action("memory.create", {
              content: "用户偏好：提醒前先确认是否需要发群。",
              kind: "user_preference",
              memory_key: "notification.confirm-group-before-send",
              scope: "global",
              scope_id: "runner"
            }, "low", false)
          ],
          confidence: 0.86,
          evidence_refs: [`external_event:${itemID}`],
          skill_run_id: "domain-run-non-issue",
          source_item_ids: [`attention_inbox_item:${itemID}`],
          summary: "需要询问、监听、提醒并写入已批准的可复用记忆。",
          target_hints: [{ confidence: 0.9, id: "demo", kind: "project" }]
        }),
        method: "POST"
      });
  
      const approved = await jsonRequest(router, `/api/pi/action-proposals/${proposal.id}/approve`, {
        body: JSON.stringify({ actor: "tester" }),
        method: "POST"
      });
      const actions = approved.actions as Array<{ execution_status?: string; pi_action_id?: string; result?: Record<string, unknown>; type: string }>;
      const byType = new Map(actions.map((item) => [item.type, item]));
      const watchID = String(byType.get("watch_thread")?.result?.watch_id || "");
      const memoryID = String(byType.get("memory.create")?.result?.memory_id || "");
      const reminderID = String(byType.get("reminder.create")?.result?.automation_id || "");
  
      expect(actions.map((item) => [item.type, item.execution_status, Boolean(item.pi_action_id)])).toEqual([
        ["ask_user", "completed", true],
        ["watch_thread", "completed", true],
        ["reminder.create", "completed", true],
        ["memory.create", "completed", true]
      ]);
      expect(byType.get("ask_user")?.result).toMatchObject({ question: "要把这个提醒发到群里吗？", status: "needs_user" });
      expect(getPiIssueCompletionWatch(db, watchID)).toMatchObject({
        status: "active",
        target_channel: "telegram",
        target_chat_id: "oc_watch",
        items: [expect.objectContaining({ issue_id: watched.id })]
      });
      expect(getAutomation(db, reminderID as `automation:${string}`)).toMatchObject({
        mode: "propose",
        name: "跟进提醒",
        next_run_at: "2999-01-01T00:00:00.000Z",
        status: "active"
      });
      expect(getAutomationTrigger(db, reminderID as `automation:${string}`)).toMatchObject({ type: "manual" });
      expect(listPiMemoryItems(db).find((item) => item.id === memoryID)).toMatchObject({
        content: "用户偏好：提醒前先确认是否需要发群。",
        disabled: 0,
        memory_key: "notification.confirm-group-before-send",
        scope: "global",
        source_id: proposal.id,
        source_type: "action_proposal"
      });
      expect(getAttentionInboxItem(db, itemID)).toMatchObject({ status: "actioned" });
  
      const timeline = await jsonRequest(router, `/api/pi/activity?proposal_id=${proposal.id}&limit=200`);
      const timelineText = JSON.stringify(timeline);
      expect(timelineText).toContain("needs_user");
      expect(timelineText).toContain("跟进提醒");
    });
  
  test("approving no_action records ignored reason and marks inbox ignored", async () => {
      const db = await openFixtureDatabase();
      const itemID = seedBugReport(db);
      const router = createDefaultRouter({ database: db });
      const proposal = await jsonRequest(router, "/api/pi/action-proposals", {
        body: JSON.stringify({
          actions: [action("no_action", { reason: "这是重复通知，不需要处理。" }, "low", false)],
          confidence: 0.7,
          evidence_refs: [`external_event:${itemID}`],
          skill_run_id: "domain-run-no-action",
          source_item_ids: [`attention_inbox_item:${itemID}`],
          summary: "重复通知无需处理。",
          target_hints: []
        }),
        method: "POST"
      });
  
      const approved = await jsonRequest(router, `/api/pi/action-proposals/${proposal.id}/approve`, {
        body: JSON.stringify({ actor: "tester" }),
        method: "POST"
      });
      const [noAction] = approved.actions as Array<{ execution_status?: string; pi_action_id?: string; result?: Record<string, unknown>; type: string }>;
  
      expect(noAction).toMatchObject({
        execution_status: "completed",
        result: { ignored: true, reason: "这是重复通知，不需要处理。", status: "ignored" },
        type: "no_action"
      });
      expect(noAction.pi_action_id).toBeTruthy();
      expect(getAttentionInboxItem(db, itemID)).toMatchObject({ status: "ignored" });
  
      const timeline = await jsonRequest(router, `/api/pi/activity?proposal_id=${proposal.id}&limit=200`);
      expect(JSON.stringify(timeline)).toContain("这是重复通知");
    });
  
  test("source issue policy can allow triage issue creation with audit event", async () => {
      const db = await openFixtureDatabase();
      seedProject(db, "demo");
      const router = createDefaultRouter({ database: db });
      const proposal = await jsonRequest(router, "/api/pi/action-proposals", {
        body: JSON.stringify({
          actions: [
            action("issue.create", {
              body: "来自 source policy 的低风险 triage issue。",
              project_id: "demo",
              source_policy: { issue_policy: { auto_create_triage_issue: true } },
              status: "triage",
              title: "Source policy triage"
            }, "medium", true)
          ],
          evidence_refs: ["external_event:1"],
          skill_run_id: "domain-run-policy",
          source_item_ids: ["attention_inbox_item:1"],
          summary: "允许按 policy 自动创建 triage issue。",
          target_hints: [{ confidence: 0.9, id: "demo", kind: "project" }]
        }),
        method: "POST"
      });
  
      const approved = await jsonRequest(router, `/api/pi/action-proposals/${proposal.id}/approve`, {
        body: JSON.stringify({ actor: "tester" }),
        method: "POST"
      });
  
      expect(getPiAction(db, approved.actions[0].pi_action_id)).toMatchObject({
        gate_decision: "execute",
        requires_confirmation: 0,
        status: "completed"
      });
      expect(sourcePolicyReason(db, approved.actions[0].pi_action_id)).toBe("triage_issue_auto_create_allowed");
      expect(listIssues(db, { projectId: "demo" }).map((issue) => issue.title)).toContain("Source policy triage");
    });
}
