import { expect, test } from "bun:test";
import { buildConfig } from "../../config/env.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { getSyncOutbox, listSyncOutbox } from "../../db/repositories/imReplyOutbox.ts";
import { createImInteractionBinding } from "../../db/repositories/imInteractionBindings.ts";
import { createPiAction, getPiAction, listPiActionEvents, listPiNotificationIntents } from "../../db/repositories/pi.ts";
import { flushAgentCommunicationTestMessages } from "../../notifications/agentCommunicationGateway.testSupport.ts";
import { dispatchFeishuOutbox } from "./feishuOutboxDispatcherCompat.ts";
import { queueFeishuPiActionPendingNotification, queuePendingPiActionNotifications } from "./feishuNotifications.ts";
import type { TestFixture } from "./feishuPiActionCards.testFixture.ts";

export function registerDispatchesPendingPiActionNotificationsCases(testScope: TestFixture) {
  const { fixtureHandler, fixtureDatabase, linkedFeishuIssue, createPendingPiAction, postFeishu, piActionCallback, imInteractionCallback, FakeFeishuSender } = testScope;
  test("dispatches pending PI action notifications as an interactive card", async () => {
      const db = await fixtureDatabase();
      const sender = new FakeFeishuSender();
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
    });
  
  test("uses the project Feishu fallback and persists an explicit failure when no target exists", async () => {
      const db = await fixtureDatabase();
      const sender = new FakeFeishuSender();
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
      expect(sender.cardCalls).toEqual([]);
      expect(sender.calls[0]?.text).toContain("mcp-push");
    });
  
  test("sweeps pending Actions created without an in-process event observer into Feishu", async () => {
      const db = await fixtureDatabase();
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
    });
  
  test("does not backfill historical or unrelated pending Actions after restart", async () => {
      const db = await fixtureDatabase();
      createPiAction(db, {
        action_type: "agent.workflow_request",
        gate_decision: "ask",
        id: "historical-workflow-action",
        project_id: "demo",
        status: "pending"
      });
      createPiAction(db, {
        action_type: "assistant.tool.call",
        gate_decision: "ask",
        id: "historical-skill-action",
        project_id: "demo",
        status: "pending"
      });
      db.sqlite.run(
        "update pi_actions set created_at='2026-07-20T00:00:00.000Z' where id=?",
        ["historical-skill-action"]
      );
  
      const result = queuePendingPiActionNotifications(
        db,
        buildConfig({ feishuDefaultChatId: "oc_default" }).integrations.feishu,
        { now: new Date("2026-07-27T07:00:00.000Z") }
      );
  
      expect(result).toEqual({ failed: 0, queued: 0, scanned: 2, skipped: 2 });
      expect(listPiNotificationIntents(db, { kind: "pi_action_pending" })).toEqual([]);
      expect(listSyncOutbox(db, { source: "feishu" })).toEqual([]);
    });
  
  test("resolves approve PI action callbacks through the action dispatcher", async () => {
      const { database, handle } = await fixtureHandler();
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
      expect(database.sqlite.query<Record<string, unknown>, [string]>(
        "select status, resolution_json from im_interaction_bindings where action_ref=?"
      ).get("pi_actions:pi-action-callback-approve")).toMatchObject({
        resolution_json: expect.stringContaining('"status":"completed"'),
        status: "consumed"
      });
      expect(listPiActionEvents(database, { actionId: "pi-action-callback-approve" })
        .filter((event) => event.event_type === "feishu_callback")).toHaveLength(1);
    });
  
  test("resolves post-cutover opaque interaction callbacks once through the generic service", async () => {
      const { database, handle } = await fixtureHandler();
      const issue = createIssue(database, { project_id: "demo", status: "triage", title: "Generic callback target" });
      createPendingPiAction(database, "pi-action-generic-callback", issue.id, "Approved through generic IM");
      const binding = createImInteractionBinding(database, {
        actionKind: "pi_action",
        actionRef: "pi_actions:pi-action-generic-callback",
        actions: [{ action_id: "approve", value: "approve" }],
        actor: { id: "ou_user_1", openId: "ou_open_1" },
        connectorId: "feishu",
        expiresAt: "2027-01-01T00:00:00.000Z",
        scopeKey: "oc_group"
      });
      const callback = imInteractionCallback(binding.interaction_id, "approve");
      const first = await postFeishu(handle, callback);
      const replay = await postFeishu(handle, callback);
  
      expect(first.status).toBe(202);
      expect(await first.json()).toMatchObject({ reason: "consumed", resolution: { ok: true, status: "completed" } });
      expect(replay.status).toBe(202);
      expect(await replay.json()).toMatchObject({ reason: "already_consumed" });
      expect(getPiAction(database, "pi-action-generic-callback")?.status).toBe("completed");
    });
  
  test("supports request changes, reject, and snooze PI action callbacks", async () => {
      const { database, handle } = await fixtureHandler();
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
    });
}
