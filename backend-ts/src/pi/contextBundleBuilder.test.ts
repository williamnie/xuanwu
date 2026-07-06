import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createContextBundle } from "../db/repositories/contextBundles.ts";
import { createExternalEvent, listExternalEvents } from "../db/repositories/externalEvents.ts";
import {
  buildContextBundleFromEvents,
  buildManualContextBundleRequest
} from "./contextBundleBuilder.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("context bundle builder", () => {
  test("builds stable thread bundle with evidence refs and attachment refs", async () => {
    const db = await openFixtureDatabase();
    try {
      const previous = event(db, "m1", "2026-07-06T01:00:00Z", "我复现了登录 bug");
      const screenshot = event(db, "m2", "2026-07-06T01:01:00Z", "截图如下", {
        attachments: [{ kind: "image", mime: "image/png", name: "login.png" }],
        raw_json: { huge_payload: "raw-secret-that-must-not-enter-bundle" }
      });
      const mention = event(db, "m3", "2026-07-06T01:02:00Z", "@PI 看看这个");
      const reply = event(db, "m4", "2026-07-06T01:03:00Z", "错误码是 500", {
        normalized_message: replyMessage("m4", "m3")
      });
      event(db, "other", "2026-07-06T01:02:30Z", "另一个 thread", {
        normalized_message: message("other", "thread-b")
      });

      const bundle = buildContextBundleFromEvents(listExternalEvents(db, { source: "fixture-im" }), {
        anchorEventId: mention.id,
        createdBy: "automation",
        maxEvents: 10,
        tokenBudget: 200,
        trigger: "mention",
        windowMinutes: 5
      });

      expect(bundle).toMatchObject({
        attachment_refs: [`external_event:${screenshot.id}#attachment:0`],
        created_by: "automation",
        event_refs: [previous.id, screenshot.id, mention.id, reply.id],
        reason: "mention_thread_time_window_attachment_context",
        source: "fixture-im",
        token_budget: 200,
        trigger: "mention",
        window: {
          from: "2026-07-06T01:00:00.000Z",
          to: "2026-07-06T01:03:00.000Z"
        }
      });
      expect(bundle.evidence_refs).toEqual([
        `external_event:${previous.id}`,
        `external_event:${screenshot.id}`,
        `external_event:${mention.id}`,
        `external_event:${reply.id}`,
        `external_event:${screenshot.id}#attachment:0`
      ]);
      expect(JSON.stringify(bundle)).not.toContain("raw-secret-that-must-not-enter-bundle");

      const saved = createContextBundle(db, bundle, new Date("2026-07-06T01:04:00Z"));
      expect(saved).toMatchObject({
        event_refs: bundle.event_refs,
        reason: bundle.reason,
        source: "fixture-im"
      });
      expect(JSON.stringify(saved)).not.toContain("raw-secret-that-must-not-enter-bundle");
    } finally {
      db.close();
    }
  });

  test("maps manual recent screenshot request to source query bundle request", () => {
    const request = buildManualContextBundleRequest("看刚刚群里的截图和消息", {
      now: new Date("2026-07-06T01:10:00Z"),
      source: "fixture-im"
    });

    expect(request).toEqual({
      created_by: "user",
      reason: "manual_recent_attachment_context",
      source: "fixture-im",
      source_query: {
        attachment_kinds: ["image"],
        channel_hint: "group",
        include_messages: true,
        limit: 50,
        since: "2026-07-06T00:55:00.000Z"
      },
      trigger: "manual"
    });
  });

  test("caps automatic bundles by event count and token budget", async () => {
    const db = await openFixtureDatabase();
    try {
      event(db, "m1", "2026-07-06T01:00:00Z", "one");
      const second = event(db, "m2", "2026-07-06T01:01:00Z", "two");
      const third = event(db, "m3", "2026-07-06T01:02:00Z", "three with a very long message body");

      const bundle = buildContextBundleFromEvents(listExternalEvents(db, { source: "fixture-im" }), {
        anchorEventId: third.id,
        createdBy: "automation",
        maxEvents: 2,
        tokenBudget: 3,
        trigger: "continuous",
        windowMinutes: 5
      });

      expect(bundle.event_refs).toEqual([second.id, third.id]);
      expect(bundle.context.map((item) => item.summary.length)).toEqual([3, 6]);
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-context-bundles-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function event(
  db: RunnerDatabase,
  externalID: string,
  occurredAt: string,
  content: string,
  overrides: Record<string, unknown> = {}
) {
  return createExternalEvent(db, {
    content,
    external_id: externalID,
    occurred_at: occurredAt,
    provider: "fixture-provider",
    raw_json: { text: content },
    received_at: occurredAt,
    source: "fixture-im",
    ...overrides,
    normalized_message: overrides.normalized_message ?? message(externalID, "thread-a")
  });
}

function message(messageID: string, threadID: string): Record<string, unknown> {
  return {
    chat_id: "group-1",
    chat_type: "group",
    message_id: messageID,
    thread_id: threadID
  };
}

function replyMessage(messageID: string, replyTo: string): Record<string, unknown> {
  return { ...message(messageID, "thread-a"), reply_to_external_id: replyTo };
}
