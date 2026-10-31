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

export const openFixtureDatabase = useTestDatabase();

export const FIXTURE_SKILLS = join(import.meta.dir, "../../../test-fixtures/pi-skills");

export type ChatBundleFixture = {
  bug: number;
  bundle: ContextBundleRecord;
  followUp: number;
  noise: number;
  reply: number;
  status: number;
};

export function item(
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

export function ignoredModel(request: LlmIntakeRequest) {
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

export function createChatBundle(db: RunnerDatabase, trigger: ContextBundleTrigger = "continuous"): ChatBundleFixture {
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

export function createAttachmentBundle(db: RunnerDatabase): { bundle: ContextBundleRecord; eventID: number } {
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

export function event(db: RunnerDatabase, externalID: string, content: string) {
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
