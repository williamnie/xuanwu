import { expect } from "bun:test";
import { type RunnerDatabase } from "../../db/database.ts";
import { createContextBundle } from "../../db/repositories/contextBundles.ts";
import { createExternalEvent } from "../../db/repositories/externalEvents.ts";
import { createAttentionInboxItem, createIntakeRun } from "../../db/repositories/intakeRuns.ts";
import { listPiActionEvents } from "../../db/repositories/pi.ts";
import { getProject } from "../../db/repositories/projects.ts";
import { createDefaultRouter } from "../server.ts";
import { useTestDatabase } from "../../testing/harness.ts";



export function createTestFixture() {
  const BASE_URL = "http://127.0.0.1:3008";

  const openFixtureDatabase = useTestDatabase();

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
  return { BASE_URL, openFixtureDatabase, seedStatusQuestion, action, seedProject, seedBugReport, seedReplyEvent, sourcePolicyReason, jsonRequest };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
