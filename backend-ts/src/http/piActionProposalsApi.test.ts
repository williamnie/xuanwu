import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createContextBundle } from "../db/repositories/contextBundles.ts";
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { createAttentionInboxItem, createIntakeRun, getAttentionInboxItem } from "../db/repositories/intakeRuns.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { getIssue, listIssues } from "../db/repositories/issues.ts";
import { getAutomation, getAutomationTrigger } from "../db/repositories/automations.ts";
import { listImReplyDrafts, listSyncOutbox } from "../db/repositories/imReplyOutbox.ts";
import { getPiAction, getPiIssueCompletionWatch, listPiActionEvents, listPiActions, listPiMemoryItems } from "../db/repositories/pi.ts";
import { getProject } from "../db/repositories/projects.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("PI action proposals API", () => {
  test("persists domain skill multi-action output for list/get/approve/reject", async () => {
    const db = await openFixtureDatabase();
    try {
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
    } finally {
      db.close();
    }
  });

  test("accepts required built-in action types, custom open types, and rejects invalid payloads", async () => {
    const db = await openFixtureDatabase();
    try {
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
    } finally {
      db.close();
    }
  });

  test("approving a proposal executes issue/status/reply actions and forces reply_send confirmation without auto policy", async () => {
    const db = await openFixtureDatabase();
    try {
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
    } finally {
      db.close();
    }
  });

  test("approved reply_send queues outbox only when auto reply policy is enabled", async () => {
    const db = await openFixtureDatabase();
    try {
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
    } finally {
      db.close();
    }
  });

  test("approving non-issue proposal actions terminalizes into traceable records", async () => {
    const db = await openFixtureDatabase();
    try {
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
    } finally {
      db.close();
    }
  });

  test("approving no_action records ignored reason and marks inbox ignored", async () => {
    const db = await openFixtureDatabase();
    try {
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
    } finally {
      db.close();
    }
  });

  test("source issue policy can allow triage issue creation with audit event", async () => {
    const db = await openFixtureDatabase();
    try {
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
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-action-proposals-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function seedStatusQuestion(db: RunnerDatabase): number {
  const event = createExternalEvent(db, {
    actor: "alice",
    content: "登录页 500 修好了吗？需要回复老板。",
    external_id: "status-1",
    occurred_at: "2026-07-06T02:01:00Z",
    provider: "fixture-provider",
    received_at: "2026-07-06T02:01:01Z",
    source: "fixture-im"
  });
  const bundle = createContextBundle(db, {
    context: [],
    created_by: "automation",
    event_refs: [event.id],
    reason: "fixture_action_proposal",
    source: "fixture-im",
    trigger: "continuous",
    window: { from: "2026-07-06T02:01:00Z", to: "2026-07-06T02:01:00Z" }
  });
  const run = createIntakeRun(db, {
    bundle_id: bundle.id,
    schema_output: { items: [{ title: "登录页 500 状态" }], ignored: [] },
    skill_id: "pi.llm_intake.v1",
    status: "succeeded"
  });
  return createAttentionInboxItem(db, {
    bundle_id: bundle.id,
    confidence: 0.91,
    evidence_refs: [`external_event:${event.id}`],
    intake_run_id: run.id,
    primary_intent: "status_question",
    secondary_intents: ["reply_needed"],
    source: "fixture-im",
    suggested_actions: ["status_lookup", "reply_draft"],
    summary: "老板追问登录页 500 修复状态，需要状态查询和回复草稿。",
    target_hints: [{ confidence: 0.8, id: "demo", kind: "project", reason: "chat context" }],
    title: "老板追问登录页 500 修复状态"
  }).id;
}

function action(type: string, payload: Record<string, unknown>, risk: string, requiresApproval: boolean) {
  return { confidence: 0.7, payload, requires_approval: requiresApproval, risk, type };
}

function seedProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "codex", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  expect(getProject(db, id)).not.toBeNull();
}

function seedBugReport(db: RunnerDatabase): number {
  const event = createExternalEvent(db, {
    actor: "alice",
    content: "登录页 500，需要创建 issue 并回复。",
    external_id: "bug-1",
    normalized_message: { chat_id: "oc_bug_chat", message_id: "om_bug_1" },
    occurred_at: "2026-07-06T03:01:00Z",
    provider: "fixture-provider",
    received_at: "2026-07-06T03:01:01Z",
    source: "fixture-im"
  });
  const bundle = createContextBundle(db, {
    context: [],
    created_by: "automation",
    event_refs: [event.id],
    reason: "fixture_action_execution",
    source: "fixture-im",
    trigger: "continuous",
    window: { from: "2026-07-06T03:01:00Z", to: "2026-07-06T03:01:00Z" }
  });
  const run = createIntakeRun(db, {
    bundle_id: bundle.id,
    schema_output: { items: [{ title: "登录页 500" }], ignored: [] },
    skill_id: "pi.llm_intake.v1",
    status: "succeeded"
  });
  return createAttentionInboxItem(db, {
    bundle_id: bundle.id,
    confidence: 0.93,
    evidence_refs: [`external_event:${event.id}`],
    intake_run_id: run.id,
    primary_intent: "bug_report",
    secondary_intents: ["reply_needed"],
    source: "fixture-im",
    suggested_actions: ["create_issue_proposal", "reply_draft"],
    summary: "登录页 500，需要创建 issue 并回复。",
    target_hints: [{ confidence: 0.9, id: "demo", kind: "project" }],
    title: "登录页 500"
  }).id;
}

function seedReplyEvent(db: RunnerDatabase): number {
  return createExternalEvent(db, {
    actor: "bob",
    content: "请同步状态",
    external_id: "reply-1",
    normalized_message: { chat_id: "oc_reply_chat", message_id: "om_reply_1" },
    occurred_at: "2026-07-06T04:01:00Z",
    provider: "fixture-provider",
    received_at: "2026-07-06T04:01:01Z",
    source: "fixture-im"
  }).id;
}

function sourcePolicyReason(db: RunnerDatabase, actionID: string): string {
  const event = listPiActionEvents(db, { actionId: actionID })
    .find((item) => item.event_type === "source_policy_decision");
  return event?.reason ?? "";
}

async function jsonRequest<T = any>(router: ReturnType<typeof createDefaultRouter>, path: string, init: RequestInit = {}): Promise<T> {
  const response = await router.handle(new Request(`${BASE_URL}${path}`, {
    headers: { "content-type": "application/json" },
    ...init
  }));
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  return await response.json() as T;
}
