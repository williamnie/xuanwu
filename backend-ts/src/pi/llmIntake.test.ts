import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createContextBundle, type ContextBundleRecord } from "../db/repositories/contextBundles.ts";
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { getIntakeRun, listAttentionInboxItems } from "../db/repositories/intakeRuns.ts";
import { runLlmIntake } from "./llmIntake.ts";

const tempRoots: string[] = [];

type ChatBundleFixture = {
  bug: number;
  bundle: ContextBundleRecord;
  followUp: number;
  noise: number;
  reply: number;
  status: number;
};

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("LLM intake runs", () => {
  test("persists validated LLM attention items and ignored noise from a context bundle", async () => {
    const db = await openFixtureDatabase();
    try {
      const fixture = createChatBundle(db);

      const result = await runLlmIntake(db, fixture.bundle, async () => ({
        items: [
          item("登录报错", "bug_report", [`external_event:${fixture.bug}`], 0.92, "high"),
          item("问修复进度", "status_question", [`external_event:${fixture.status}`], 0.82, "medium"),
          item("需要回复群消息", "reply_needed", [`external_event:${fixture.reply}`], 0.88, "medium"),
          item("明天继续追踪", "follow_up", [`external_event:${fixture.followUp}`], 0.77, "low")
        ],
        ignored: [{
          confidence: 0.86,
          evidence_refs: [`external_event:${fixture.noise}`],
          group_id: "noise-chat",
          reason: "noise",
          summary: "闲聊表情无需处理"
        }]
      }), { model: "fixture-model", skillId: "pi-intake-default" });

      expect(result.run.status).toBe("succeeded");
      expect(result.run.bundle_id).toBe(fixture.bundle.id);
      expect(result.run.skill_id).toBe("pi-intake-default");
      expect(result.run.model).toBe("fixture-model");
      expect(result.created_items).toHaveLength(4);
      expect(result.created_items.map((row) => row.primary_intent)).toEqual([
        "bug_report", "status_question", "reply_needed", "follow_up"
      ]);
      expect(result.run.ignored_groups).toEqual([{
        confidence: 0.86,
        evidence_refs: [`external_event:${fixture.noise}`],
        group_id: "noise-chat",
        reason: "noise",
        summary: "闲聊表情无需处理"
      }]);

      const savedItems = listAttentionInboxItems(db, { intakeRunId: result.run.id });
      expect(savedItems).toHaveLength(4);
      expect(savedItems.every((row) => row.kind === "attention")).toBe(true);
      expect(savedItems.every((row) => row.evidence_refs.length > 0)).toBe(true);
      expect(savedItems.every((row) => row.confidence > 0)).toBe(true);
      expect(savedItems[0].target_hints).toEqual([{
        confidence: 0.7,
        id: "demo-project",
        kind: "project",
        reason: "LLM inferred from chat context"
      }]);
    } finally {
      db.close();
    }
  });

  test("records ignored reason without creating inbox item when LLM finds no attention item", async () => {
    const db = await openFixtureDatabase();
    try {
      const fixture = createChatBundle(db);

      const result = await runLlmIntake(db, fixture.bundle, async () => ({
        items: [],
        ignored: [{
          confidence: 0.8,
          evidence_refs: fixture.bundle.evidence_refs,
          reason: "no_attention_item",
          summary: "上下文没有需要关注、回复或追踪的事项"
        }]
      }));

      expect(result.run.status).toBe("succeeded");
      expect(result.created_items).toEqual([]);
      expect(result.run.ignored_groups).toEqual([{
        confidence: 0.8,
        evidence_refs: fixture.bundle.evidence_refs,
        reason: "no_attention_item",
        summary: "上下文没有需要关注、回复或追踪的事项"
      }]);
      expect(listAttentionInboxItems(db, { intakeRunId: result.run.id })).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("records a failed intake run when LLM schema output is invalid", async () => {
    const db = await openFixtureDatabase();
    try {
      const fixture = createChatBundle(db);

      await expect(runLlmIntake(db, fixture.bundle, async () => ({
        items: [{
          confidence: 1.4,
          intents: { primary: "bug_report" },
          suggested_actions: ["create_task"],
          title: "缺少 evidence_refs"
        }],
        ignored: []
      }))).rejects.toThrow("intake output failed schema validation");

      const run = getIntakeRun(db, 1);
      expect(run?.status).toBe("failed");
      expect(run?.error).toContain("intake output failed schema validation");
      expect(listAttentionInboxItems(db, { intakeRunId: 1 })).toEqual([]);
    } finally {
      db.close();
    }
  });
});

function item(
  title: string,
  primary: string,
  evidenceRefs: string[],
  confidence: number,
  urgency: "low" | "medium" | "high"
) {
  return {
    actor_refs: ["user:alice"],
    confidence,
    evidence_refs: evidenceRefs,
    intents: { primary, secondary: [], tags: [] },
    suggested_actions: ["triage_attention_item"],
    summary: `${title} summary`,
    target_hints: [{
      confidence: 0.7,
      id: "demo-project",
      kind: "project",
      reason: "LLM inferred from chat context"
    }],
    title,
    urgency
  };
}

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-llm-intake-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function createChatBundle(db: RunnerDatabase): ChatBundleFixture {
  const bug = event(db, "m1", "登录页 500 了，截图里有报错");
  const status = event(db, "m2", "这个问题现在修到哪了？");
  const reply = event(db, "m3", "@PI 帮我回复一下群里");
  const followUp = event(db, "m4", "明天上午继续跟进");
  const noise = event(db, "m5", "哈哈 😂");
  const eventRefs = [bug, status, reply, followUp, noise].map((row) => row.id);
  const bundle = createContextBundle(db, {
    context: [bug, status, reply, followUp, noise].map((row) => ({
      actor: row.actor,
      attachment_refs: [],
      event_ref: row.id,
      occurred_at: row.occurred_at,
      source_ref: `fixture-im:${row.external_id}`,
      summary: row.content
    })),
    created_by: "automation",
    event_refs: eventRefs,
    reason: "fixture_llm_intake",
    source: "fixture-im",
    token_budget: 1200,
    trigger: "continuous",
    window: { from: bug.occurred_at, to: noise.occurred_at }
  }, new Date("2026-07-06T02:10:00Z"));
  return { bug: bug.id, bundle, followUp: followUp.id, noise: noise.id, reply: reply.id, status: status.id };
}

function event(db: RunnerDatabase, externalID: string, content: string) {
  const occurredAt = `2026-07-06T02:0${externalID.slice(1)}:00Z`;
  return createExternalEvent(db, {
    actor: "alice",
    content,
    external_id: externalID,
    occurred_at: occurredAt,
    provider: "fixture-provider",
    raw_json: { text: content },
    received_at: occurredAt,
    source: "fixture-im"
  });
}
