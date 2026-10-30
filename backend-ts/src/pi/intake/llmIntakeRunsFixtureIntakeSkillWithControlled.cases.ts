import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type RunnerDatabase } from "../../db/database.ts";
import type { ContextBundleTrigger } from "../../db/repositories/contextBundles.ts";
import { createContextBundle, type ContextBundleRecord } from "../../db/repositories/contextBundles.ts";
import { createExternalEvent } from "../../db/repositories/externalEvents.ts";
import { getIntakeRun, listAttentionInboxItems, listIntakeRuns } from "../../db/repositories/intakeRuns.ts";
import { createPiMemoryItem } from "../../db/repositories/pi.ts";
import { readSkillRegistry } from "../../skills/registry.ts";
import { runIntakeSkill, runLlmIntake, type LlmIntakeRequest } from "./llmIntake.ts";
import { useTestDatabase } from "../../testing/harness.ts";

import { openFixtureDatabase, FIXTURE_SKILLS, ChatBundleFixture, item, ignoredModel, createChatBundle, createAttachmentBundle, event } from "./llmIntakeTestFixtures.ts";

export function registerRunsFixtureIntakeSkillWithControlled() {
test("runs fixture intake skill with controlled OCR and raw-event summaries", async () => {
    const db = await openFixtureDatabase();
    const fixture = createAttachmentBundle(db);
    createPiMemoryItem(db, {
      content: "Fixture source maps login screenshots to demo project candidates.",
      id: "fixture-source-memory",
      kind: "source_project_hint",
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
  });

test("persists validated LLM attention items and ignored noise from a context bundle", async () => {
    const db = await openFixtureDatabase();
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
  });

test("applies source policy to automatic intake while manual uses the same runtime path", async () => {
    const db = await openFixtureDatabase();
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
  });

test("retrying the same evidence updates the inbox item instead of duplicating it", async () => {
    const db = await openFixtureDatabase();
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
  });

test("records ignored reason without creating inbox item when LLM finds no attention item", async () => {
    const db = await openFixtureDatabase();
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
  });

test("records a failed intake run when LLM schema output is invalid", async () => {
    const db = await openFixtureDatabase();
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
  });
}
