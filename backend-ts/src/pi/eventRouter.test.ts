import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createContextBundle, type ContextBundleTrigger } from "../db/repositories/contextBundles.ts";
import { createExternalEvent, listExternalEvents } from "../db/repositories/externalEvents.ts";
import { createAttentionInboxItem, createIntakeRun, listIntakeRuns } from "../db/repositories/intakeRuns.ts";
import { listPiActions } from "../db/repositories/pi.ts";
import {
  decideInboxRoute,
  resolveSourcePolicy,
  routeContextBundleToIntake,
  routeInboxItemToDomainSkill,
  routeRawEventToIntake
} from "./eventRouter.ts";
import type { LlmIntakeModel } from "./llmIntake.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("PI event router", () => {
  test("source profiles expose default intake and action policy", () => {
    expect(resolveSourcePolicy({ profile: "company_chat" })).toMatchObject({
      action_mode: "draft_only",
      intake_mode: "mention_only"
    });
    expect(resolveSourcePolicy({ profile: "personal_chat" })).toMatchObject({
      action_mode: "auto_low_risk",
      intake_mode: "mention_only",
      reply_policy: { auto_reply_enabled: false }
    });
    expect(resolveSourcePolicy({ profile: "ops_chat" })).toMatchObject({
      action_mode: "propose_actions",
      intake_mode: "scheduled_llm_triage"
    });
    expect(resolveSourcePolicy({ profile: "private_dm" })).toMatchObject({
      action_mode: "auto_low_risk",
      intake_mode: "mention_only",
      reply_policy: { auto_reply_enabled: false }
    });
  });

  test("source policy can disable raw event collection before intake", async () => {
    const db = await openFixtureDatabase();
    try {
      const model = countingIgnoredModel();
      const mention = event(db, "m-disabled", "@PI 看一下");

      const route = await routeRawEventToIntake(db, mention, [mention], model.run, {
        policy: { collect_raw_events: false, profile: "company_chat" }
      });

      expect(route).toMatchObject({ reason: "collect_raw_events_disabled", status: "skipped" });
      expect(model.calls()).toBe(0);
    } finally {
      db.close();
    }
  });

  test("mention_only only routes mention reply and user-trigger bundles to intake", async () => {
    const db = await openFixtureDatabase();
    try {
      const model = countingIgnoredModel();
      const noise = event(db, "m1", "今晚吃啥？");
      const mention = event(db, "m2", "@PI 看看这个报错");
      const reply = event(db, "m3", "补充一下错误码", { normalized_message: { reply_to_bot: true } });

      const noiseRoute = await routeRawEventToIntake(db, noise, [noise], model.run, { policy: { profile: "company_chat" } });
      const mentionRoute = await routeRawEventToIntake(db, mention, [mention], model.run, { policy: { profile: "company_chat" } });
      const replyRoute = await routeRawEventToIntake(db, reply, [reply], model.run, { policy: { profile: "company_chat" } });
      const manualRoute = await routeContextBundleToIntake(db, bundle(db, "manual"), model.run, { policy: { profile: "company_chat" } });
      const scheduleRoute = await routeContextBundleToIntake(db, bundle(db, "schedule"), model.run, { policy: { profile: "company_chat" } });

      expect(noiseRoute).toMatchObject({ reason: "trigger_continuous_not_allowed", status: "skipped" });
      expect(mentionRoute.status).toBe("routed");
      expect(replyRoute.status).toBe("routed");
      expect(manualRoute.status).toBe("routed");
      expect(scheduleRoute).toMatchObject({ reason: "trigger_schedule_not_allowed", status: "skipped" });
      expect(model.calls()).toBe(3);
    } finally {
      db.close();
    }
  });

  test("scheduled_llm_triage can route scheduled intake and dedupes context bundles", async () => {
    const db = await openFixtureDatabase();
    try {
      const model = countingIgnoredModel();
      const scheduled = bundle(db, "schedule");

      const first = await routeContextBundleToIntake(db, scheduled, model.run, { policy: { profile: "ops_chat" } });
      const duplicate = await routeContextBundleToIntake(db, scheduled, model.run, { policy: { profile: "ops_chat" } });
      const retried = await routeContextBundleToIntake(db, scheduled, model.run, { policy: { profile: "ops_chat" }, retry: true });

      expect(first.status).toBe("routed");
      expect(duplicate).toMatchObject({ reason: "duplicate_context_bundle", status: "skipped" });
      expect(retried.status).toBe("routed");
      expect(model.calls()).toBe(2);
      expect(listIntakeRuns(db, { bundleId: scheduled.id })).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test("raw events are not routed twice unless retry is explicit", async () => {
    const db = await openFixtureDatabase();
    try {
      const model = countingIgnoredModel();
      const mention = event(db, "m1", "@PI 帮我看一下");

      const first = await routeRawEventToIntake(db, mention, listExternalEvents(db), model.run, { policy: { profile: "company_chat" } });
      const duplicate = await routeRawEventToIntake(db, mention, listExternalEvents(db), model.run, { policy: { profile: "company_chat" } });
      const retried = await routeRawEventToIntake(db, mention, listExternalEvents(db), model.run, { policy: { profile: "company_chat" }, retry: true });

      expect(first.status).toBe("routed");
      expect(duplicate).toMatchObject({ reason: "duplicate_raw_event", status: "skipped" });
      expect(retried.status).toBe("routed");
      expect(model.calls()).toBe(2);
    } finally {
      db.close();
    }
  });

  test("inbox items route to domain skill by action mode and dedupe proposals", async () => {
    const db = await openFixtureDatabase();
    try {
      const lowRisk = inboxItem(db, "status_question", ["issue.status_lookup"], "low");
      const bug = inboxItem(db, "bug_report", ["issue.create"], "high");

      expect(decideInboxRoute(bug, { profile: "company_chat" })).toEqual({
        decision: "ask_user",
        reason: "project_confirmation_required"
      });
      const first = routeInboxItemToDomainSkill(db, lowRisk, {
        policy: { profile: "private_dm" },
        project: { project_confirmed: true, project_id: "demo" }
      });
      const duplicate = routeInboxItemToDomainSkill(db, lowRisk, {
        policy: { profile: "private_dm" },
        project: { project_confirmed: true, project_id: "demo" }
      });
      const retried = routeInboxItemToDomainSkill(db, lowRisk, {
        policy: { profile: "private_dm" },
        project: { project_confirmed: true, project_id: "demo" },
        retry: true
      });

      expect(first).toMatchObject({ decision: "auto_low_risk", status: "routed" });
      expect(duplicate).toMatchObject({ reason: "duplicate_inbox_item", status: "skipped" });
      expect(retried).toMatchObject({ decision: "auto_low_risk", status: "routed" });
      expect(listPiActions(db, { status: "proposal" })).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-event-router-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function countingIgnoredModel(): { calls: () => number; run: LlmIntakeModel } {
  let count = 0;
  return {
    calls: () => count,
    run: ({ bundle }) => {
      count += 1;
      return {
        ignored_groups: [{
          confidence: 0.9,
          evidence_refs: bundle.evidence_refs,
          reason: "no_attention_item"
        }],
        inbox_items: []
      };
    }
  };
}

function event(db: RunnerDatabase, externalID: string, content: string, overrides: Record<string, unknown> = {}) {
  return createExternalEvent(db, {
    content,
    external_id: externalID,
    occurred_at: "2026-07-06T01:00:00Z",
    provider: "fixture-provider",
    raw_json: { text: content },
    received_at: "2026-07-06T01:00:00Z",
    source: "fixture-im",
    ...overrides
  });
}

function bundle(db: RunnerDatabase, trigger: ContextBundleTrigger) {
  const anchor = event(db, `bundle-${trigger}-${crypto.randomUUID()}`, `bundle ${trigger}`);
  return createContextBundle(db, {
    created_by: trigger === "manual" ? "user" : "automation",
    event_refs: [anchor.id],
    reason: `${trigger}_fixture`,
    source: anchor.source,
    trigger,
    window: { from: anchor.occurred_at, to: anchor.occurred_at }
  });
}

function inboxItem(
  db: RunnerDatabase,
  primaryIntent: string,
  suggestedActions: string[],
  urgency: "low" | "medium" | "high"
) {
  const run = createIntakeRun(db, {
    bundle_id: bundle(db, "mention").id,
    skill_id: "fixture-intake",
    status: "succeeded"
  });
  return createAttentionInboxItem(db, {
    bundle_id: run.bundle_id,
    confidence: 0.9,
    evidence_refs: [`external_event:${run.bundle_id}`],
    intake_run_id: run.id,
    primary_intent: primaryIntent,
    source: "fixture-im",
    suggested_actions: suggestedActions,
    summary: `${primaryIntent} summary`,
    title: `${primaryIntent} title`,
    urgency
  });
}
