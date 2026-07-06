import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createContextBundle } from "../db/repositories/contextBundles.ts";
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { createAttentionInboxItem, createIntakeRun } from "../db/repositories/intakeRuns.ts";
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

async function jsonRequest(router: ReturnType<typeof createDefaultRouter>, path: string, init: RequestInit = {}) {
  const response = await router.handle(new Request(`${BASE_URL}${path}`, {
    headers: { "content-type": "application/json" },
    ...init
  }));
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  return response.json();
}
