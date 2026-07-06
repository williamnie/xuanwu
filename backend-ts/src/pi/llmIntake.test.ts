import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import type { ContextBundleTrigger } from "../db/repositories/contextBundles.ts";
import { createContextBundle, type ContextBundleRecord } from "../db/repositories/contextBundles.ts";
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { getIntakeRun, listAttentionInboxItems, listIntakeRuns } from "../db/repositories/intakeRuns.ts";
import { createPiMemoryItem } from "../db/repositories/pi.ts";
import { readSkillRegistry } from "../skills/registry.ts";
import { runIntakeSkill, runLlmIntake, type LlmIntakeRequest } from "./llmIntake.ts";

const tempRoots: string[] = [];
const FIXTURE_SKILLS = join(import.meta.dir, "../../../docs/fixtures/pi-skills");

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
  test("runs fixture intake skill with controlled OCR and raw-event summaries", async () => {
    const db = await openFixtureDatabase();
    try {
      const fixture = createAttachmentBundle(db);
      createPiMemoryItem(db, {
        content: "Fixture source maps login screenshots to demo project candidates.",
        id: "fixture-source-memory",
        kind: "source_context",
        scope: "source",
        scope_id: "fixture-im"
      });
      createPiMemoryItem(db, {
        content: "Demo project login failures should preserve screenshot evidence.",
        id: "fixture-project-memory",
        kind: "project_policy",
        scope: "project",
        scope_id: "demo"
      });
      const skill = readSkillRegistry({
        availableTools: [{ name: "source.fetch_context", permission: "read" }],
        roots: [{ label: "fixture", path: FIXTURE_SKILLS }]
      }).items.find((item) => item.id === "fixture-intake");
      let captured: LlmIntakeRequest | undefined;

      const result = await runIntakeSkill(db, fixture.bundle, async (request) => {
        captured = request;
        return {
          inbox_items: [item("登录截图报错", "bug_report", fixture.bundle.evidence_refs, 0.93, "high")],
          ignored_groups: []
        };
      }, { modelPolicy: { intake_model: "main-intake-model" }, skill });

      expect(result.run.skill_id).toBe("fixture-intake");
      expect(result.run.model).toBe("main-intake-model");
      expect(result.created_items).toHaveLength(1);
      expect(captured?.input.context_bundle.raw_event_summaries[0]).toMatchObject({
        summary: "用户截图显示登录页 500",
        attachments: [expect.objectContaining({
          ocr_text: "500 Internal Server Error",
          vision_summary: "login page screenshot with red 500 error"
        })]
      });
      expect(captured?.input.context_retrieval.memory_items.map((item) => item.id)).toEqual([
        "fixture-source-memory",
        "fixture-project-memory"
      ]);
      expect(captured?.prompt).toContain("context_retrieval");
      expect(captured?.prompt).toContain("Fixture source maps login screenshots");
      expect(captured?.prompt).toContain("pi_memory_items/fixture-source-memory");
      expect(captured?.prompt).toContain("raw_event_summaries");
      expect(captured?.prompt).toContain("500 Internal Server Error");
      expect(captured?.prompt).toContain("login page screenshot with red 500 error");
      expect(captured?.prompt).not.toContain("very-large-raw-payload");
      expect(captured?.prompt).not.toContain("file:///tmp/raw-login.png");
      expect(captured?.prompt).not.toContain("remote-secret-ref");
    } finally {
      db.close();
    }
  });

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

  test("applies source policy to automatic intake while manual uses the same runtime path", async () => {
    const db = await openFixtureDatabase();
    try {
      const scheduled = createChatBundle(db, "schedule");
      const policy = { frequency_limit_ms: 60_000, intake_mode: "scheduled_llm_triage" as const };

      await runIntakeSkill(db, scheduled.bundle, ignoredModel, { sourcePolicy: policy });
      const blocked = createChatBundle(db, "schedule");
      await expect(runIntakeSkill(db, blocked.bundle, ignoredModel, { sourcePolicy: policy }))
        .rejects.toThrow("frequency_limited");

      const manual = createChatBundle(db, "manual");
      const result = await runIntakeSkill(db, manual.bundle, ignoredModel, {
        sourcePolicy: { automatic_intake_enabled: false, intake_mode: "manual_only" }
      });

      expect(result.run.status).toBe("succeeded");
      expect(listIntakeRuns(db, { status: "succeeded" })).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test("retrying the same evidence updates the inbox item instead of duplicating it", async () => {
    const db = await openFixtureDatabase();
    try {
      const fixture = createChatBundle(db);
      const first = await runIntakeSkill(db, fixture.bundle, async () => ({
        inbox_items: [item("初次标题", "bug_report", [`external_event:${fixture.bug}`], 0.8, "medium")],
        ignored_groups: []
      }));
      const second = await runIntakeSkill(db, fixture.bundle, async () => ({
        inbox_items: [item("更新标题", "bug_report", [`external_event:${fixture.bug}`], 0.9, "high")],
        ignored_groups: []
      }));

      const savedItems = listAttentionInboxItems(db, { source: fixture.bundle.source });
      expect(savedItems).toHaveLength(1);
      expect(savedItems[0]).toMatchObject({
        id: first.created_items[0].id,
        intake_run_id: second.run.id,
        title: "更新标题",
        urgency: "high"
      });
      expect(listIntakeRuns(db, { bundleId: fixture.bundle.id })).toHaveLength(2);
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

function ignoredModel(request: LlmIntakeRequest) {
  return {
    ignored_groups: [{
      confidence: 0.8,
      evidence_refs: request.bundle.evidence_refs,
      reason: "no_attention_item",
      summary: "无须处理"
    }],
    inbox_items: []
  };
}

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-llm-intake-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function createChatBundle(db: RunnerDatabase, trigger: ContextBundleTrigger = "continuous"): ChatBundleFixture {
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
    created_by: trigger === "manual" ? "user" : "automation",
    event_refs: eventRefs,
    reason: "fixture_llm_intake",
    source: "fixture-im",
    token_budget: 1200,
    trigger,
    window: { from: bug.occurred_at, to: noise.occurred_at }
  }, new Date("2026-07-06T02:10:00Z"));
  return { bug: bug.id, bundle, followUp: followUp.id, noise: noise.id, reply: reply.id, status: status.id };
}

function createAttachmentBundle(db: RunnerDatabase): { bundle: ContextBundleRecord; eventID: number } {
  const created = "2026-07-06T03:01:00Z";
  const row = createExternalEvent(db, {
    actor: "alice",
    attachments: [{
      kind: "image",
      local_ref: "file:///tmp/raw-login.png",
      name: "login.png",
      ocr_text: "500 Internal Server Error",
      remote_ref: "remote-secret-ref",
      vision_summary: "login page screenshot with red 500 error"
    }],
    content: "用户截图显示登录页 500",
    external_id: "img-1",
    occurred_at: created,
    provider: "fixture-provider",
    raw_json: { detail: "very-large-raw-payload" },
    received_at: created,
    source: "fixture-im",
    summary: { normalized_summary: "登录页截图出现 500" }
  });
  return {
    bundle: createContextBundle(db, {
      context: [{
        actor: row.actor,
        attachment_refs: [`external_event:${row.id}#attachment:0`],
        event_ref: row.id,
        occurred_at: row.occurred_at,
        source_ref: `fixture-im:${row.external_id}`,
        summary: "用户截图显示登录页 500"
      }],
      attachment_refs: [`external_event:${row.id}#attachment:0`],
      created_by: "automation",
      event_refs: [row.id],
      reason: "fixture_intake_attachment",
      source: "fixture-im",
      source_query: { project_id: "demo" },
      token_budget: 1200,
      trigger: "continuous",
      window: { from: created, to: created }
    }),
    eventID: row.id
  };
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
