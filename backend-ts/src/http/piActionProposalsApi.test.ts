import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createContextBundle } from "../db/repositories/contextBundles.ts";
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { createAttentionInboxItem, createIntakeRun } from "../db/repositories/intakeRuns.ts";
import { getIssue, listIssues } from "../db/repositories/issues.ts";
import { listImReplyDrafts, listSyncOutbox } from "../db/repositories/imReplyOutbox.ts";
import { getPiAction, listPiActionEvents, listPiActions } from "../db/repositories/pi.ts";
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
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-action-proposals-"));
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

async function jsonRequest(router: ReturnType<typeof createDefaultRouter>, path: string, init: RequestInit = {}) {
  const response = await router.handle(new Request(`${BASE_URL}${path}`, {
    headers: { "content-type": "application/json" },
    ...init
  }));
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  return response.json();
}
