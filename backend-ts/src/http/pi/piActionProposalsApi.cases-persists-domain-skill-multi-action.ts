import { expect, test } from "bun:test";
import { getIssue, listIssues } from "../../db/repositories/issues.ts";
import { listImReplyDrafts, listSyncOutbox } from "../../db/repositories/imReplyOutbox.ts";
import { getPiAction, listPiActions } from "../../db/repositories/pi.ts";
import { createDefaultRouter } from "../server.ts";
import type { TestFixture } from "./piActionProposalsApi.testFixture.ts";

export function registerPersistsDomainSkillMultiActionCases(testScope: TestFixture) {
  const { BASE_URL, openFixtureDatabase, seedStatusQuestion, action, seedProject, seedBugReport, sourcePolicyReason, jsonRequest } = testScope;
  test("persists domain skill multi-action output for list/get/approve/reject", async () => {
      const db = await openFixtureDatabase();
      const itemID = seedStatusQuestion(db);
      const router = createDefaultRouter({ database: db });
  
      const run = await jsonRequest(router, `/api/pi/attention-inbox/items/${itemID}/domain-skill`, { method: "POST" });
      const proposal = run.proposal as Record<string, unknown>;
      expect(proposal).toMatchObject({
        skill_run_id: run.action.id,
        source_item_ids: [`attention_inbox_item:${itemID}`],
        status: "proposed"
      });
      expect((proposal.actions as Array<{ type: string }>).map((action) => action.type)).toEqual([
        "issue.status_lookup",
        "message.reply_draft"
      ]);
  
      const listed = await jsonRequest(router, "/api/pi/action-proposals?status=proposed");
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ id: proposal.id, evidence_refs: [`external_event:${itemID}`] });
  
      const fetched = await jsonRequest(router, `/api/pi/action-proposals/${proposal.id}`);
      expect(fetched.actions).toEqual(proposal.actions);
  
      const approved = await jsonRequest(router, `/api/pi/action-proposals/${proposal.id}/approve`, {
        body: JSON.stringify({ actor: "tester" }),
        method: "POST"
      });
      expect(approved).toMatchObject({ approved_by: "tester", status: "approved" });
  
      const noAction = await jsonRequest(router, "/api/pi/action-proposals", {
        body: JSON.stringify({
          actions: [{ payload: { reason: "duplicate chatter" }, requires_approval: false, risk: "low", type: "no_action" }],
          confidence: 0.31,
          evidence_refs: ["ignored_group:bundle-1:noise"],
          skill_run_id: "ignored-group-run",
          source_item_ids: ["ignored_group:bundle-1:noise"],
          summary: "Ignored duplicate chat noise.",
          target_hints: []
        }),
        method: "POST"
      });
      const rejected = await jsonRequest(router, `/api/pi/action-proposals/${noAction.id}/reject`, {
        body: JSON.stringify({ actor: "tester", reason: "audit only" }),
        method: "POST"
      });
      expect(rejected).toMatchObject({ decided_by: "tester", decision_reason: "audit only", status: "rejected" });
    });
  
  test("accepts required built-in action types, custom open types, and rejects invalid payloads", async () => {
      const db = await openFixtureDatabase();
      const router = createDefaultRouter({ database: db });
  
      const created = await jsonRequest(router, "/api/pi/action-proposals", {
        body: JSON.stringify({
          actions: [
            action("issue.create", { body: "Body", title: "Create issue" }, "medium", true),
            action("issue.enqueue", { issue_id: 123 }, "high", true),
            action("message.reply_draft", { draft: "Draft reply" }, "low", false),
            action("message.reply_send", { text: "Send reply" }, "high", true),
            action("issue.status_lookup", { query: "登录页 500" }, "low", false),
            action("ask_user", { question: "要继续处理吗？" }, "low", false),
            action("watch_thread", { thread_id: "thread-1" }, "low", false),
            action("memory.create", { content: "Remember this preference" }, "low", false),
            action("reminder.create", { title: "Follow up", due_at: "2026-07-08T00:00:00Z" }, "low", false),
            action("no_action", { reason: "no work needed" }, "low", false),
            action("calendar.schedule", { title: "Open custom action" }, "medium", true)
          ],
          confidence: 0.88,
          evidence_refs: ["external_event:1"],
          skill_run_id: "domain-skill-run-1",
          source_item_ids: ["attention_inbox_item:1"],
          summary: "Open action type coverage.",
          target_hints: [{ confidence: 0.8, id: "demo", kind: "project" }]
        }),
        method: "POST"
      });
      expect(created.actions.map((item: { type: string }) => item.type)).toEqual([
        "issue.create",
        "issue.enqueue",
        "message.reply_draft",
        "message.reply_send",
        "issue.status_lookup",
        "ask_user",
        "watch_thread",
        "memory.create",
        "reminder.create",
        "no_action",
        "calendar.schedule"
      ]);
  
      const invalid = await router.handle(new Request(`${BASE_URL}/api/pi/action-proposals`, {
        body: JSON.stringify({
          actions: [{ payload: {}, requires_approval: true, risk: "medium", type: "issue.enqueue" }],
          skill_run_id: "bad-run",
          source_item_ids: ["attention_inbox_item:1"],
          summary: "Invalid enqueue"
        }),
        method: "POST"
      }));
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ message: "action payload for issue.enqueue requires issue_id" });
    });
  
  test("approving a proposal executes issue/status/reply actions and forces reply_send confirmation without auto policy", async () => {
      const db = await openFixtureDatabase();
      seedProject(db, "demo");
      const itemID = seedBugReport(db);
      const router = createDefaultRouter({ database: db });
  
      const proposal = await jsonRequest(router, "/api/pi/action-proposals", {
        body: JSON.stringify({
          actions: [
            action("issue.create", {
              body: "登录页 500，需要排查并回写结论。",
              title: "登录页 500"
            }, "medium", true),
            action("issue.status_lookup", { query: "登录页 500" }, "low", false),
            action("message.reply_draft", {
              draft: "旧草稿",
              source: "fixture-im"
            }, "low", false),
            action("message.reply_send", {
              source: "fixture-im",
              text: "确认后发送"
            }, "low", false)
          ],
          confidence: 0.91,
          evidence_refs: [`external_event:${itemID}`],
          skill_run_id: "domain-run-execute",
          source_item_ids: [`attention_inbox_item:${itemID}`],
          summary: "需要创建 issue、查询状态并准备回复。",
          target_hints: [{ confidence: 0.9, id: "demo", kind: "project" }]
        }),
        method: "POST"
      });
  
      const approved = await jsonRequest(router, `/api/pi/action-proposals/${proposal.id}/approve`, {
        body: JSON.stringify({
          action_edits: {
            [proposal.actions[2].id]: { payload: { draft: "编辑后的草稿" } }
          },
          actor: "tester"
        }),
        method: "POST"
      });
  
      const created = listIssues(db, { projectId: "demo" }).find((issue) => issue.title === "登录页 500");
      const actions = listPiActions(db);
      expect(approved).toMatchObject({ approved_by: "tester", status: "approved" });
      expect(approved.actions.map((item: { execution_status?: string; type: string }) => [item.type, item.execution_status]))
        .toEqual([
          ["issue.create", "completed"],
          ["issue.status_lookup", "completed"],
          ["message.reply_draft", "completed"],
          ["message.reply_send", "completed"]
        ]);
      expect(created).toMatchObject({
        description: expect.stringContaining("登录页 500，需要排查"),
        source_turn_id: `attention_inbox_item:${itemID}`,
        status: "triage"
      });
      expect(listImReplyDrafts(db, { source: "fixture-im" })).toEqual(expect.arrayContaining([
        expect.objectContaining({ content: "编辑后的草稿", status: "pending" }),
        expect.objectContaining({ content: "确认后发送", status: "approved" })
      ]));
      expect(listSyncOutbox(db, { source: "fixture-im" })).toMatchObject([
        expect.objectContaining({ content: "确认后发送", status: "pending" })
      ]);
      expect(getPiAction(db, approved.actions[3].pi_action_id)).toMatchObject({
        gate_decision: "ask",
        requires_confirmation: 1,
        status: "completed"
      });
      expect(sourcePolicyReason(db, approved.actions[0].pi_action_id)).toBe("auto_create_triage_issue_disabled");
      expect(sourcePolicyReason(db, approved.actions[3].pi_action_id)).toBe("auto_reply_disabled");
      expect(actions.map((item) => item.action_type).sort()).toEqual([
        "issue.create",
        "issue.status_lookup",
        "message.reply_draft",
        "message.reply_send"
      ]);
      expect((await jsonRequest(router, `/api/pi/attention-inbox/items/${itemID}`)).status).toBe("actioned");
      expect(getIssue(db, created?.id ?? 0)?.source_excerpt).toContain(proposal.id);
    });
}
