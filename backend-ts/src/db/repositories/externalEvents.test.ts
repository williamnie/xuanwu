import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../database.ts";
import { createExternalEvent, getExternalEvent, listExternalEvents, upsertExternalEvent } from "./externalEvents.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("external event repository", () => {
  test("requires source, content, and dedupe_key before persistence", async () => {
    const db = await openFixtureDatabase();
    try {
      expect(() => createExternalEvent(db, {
        content: "QA ticket",
        dedupe_key: "qa-1",
        source: ""
      })).toThrow("source is required");
      expect(() => createExternalEvent(db, {
        content: "",
        dedupe_key: "qa-1",
        source: "qa"
      })).toThrow("content is required");
      expect(() => createExternalEvent(db, {
        content: "QA ticket",
        dedupe_key: "",
        source: "qa"
      })).toThrow("dedupe_key is required");
      expect(db.sqlite.query("select count(*) as count from external_events").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  test("persists defaults and can query by source plus dedupe_key", async () => {
    const db = await openFixtureDatabase();
    try {
      const event = createExternalEvent(db, {
        content: "Login fails on staging",
        dedupe_key: "ticket-123",
        source: "qa"
      }, new Date("2026-06-12T10:00:00Z"));
      const otherSource = createExternalEvent(db, {
        content: "Same external key from IM",
        dedupe_key: "ticket-123",
        source: "im"
      }, new Date("2026-06-12T10:01:00Z"));

      expect(event).toMatchObject({
        actor: "",
        content: "Login fails on staging",
        dedupe_key: "ticket-123",
        external_id: "",
        project_hint: "",
        raw_payload_ref: "",
        received_at: "2026-06-12T10:00:00.000Z",
        source: "qa",
        trust_level: "untrusted"
      });
      expect(getExternalEvent(db, event.id)).toEqual(event);
      expect(listExternalEvents(db, {
        dedupeKey: "ticket-123",
        source: "qa"
      }).map((item) => item.id)).toEqual([event.id]);
      expect(listExternalEvents(db, {
        dedupeKey: "ticket-123",
        source: "im"
      }).map((item) => item.id)).toEqual([otherSource.id]);
    } finally {
      db.close();
    }
  });

  test("lists newest received events first with id tie-breaker", async () => {
    const db = await openFixtureDatabase();
    try {
      const older = createExternalEvent(db, {
        content: "older",
        dedupe_key: "older",
        received_at: "2026-06-12T09:00:00Z",
        source: "qa"
      });
      const sameFirst = createExternalEvent(db, {
        content: "same first",
        dedupe_key: "same-1",
        received_at: "2026-06-12T10:00:00Z",
        source: "qa"
      });
      const sameSecond = createExternalEvent(db, {
        content: "same second",
        dedupe_key: "same-2",
        received_at: "2026-06-12T10:00:00Z",
        source: "qa"
      });
      const newer = createExternalEvent(db, {
        content: "newer",
        dedupe_key: "newer",
        received_at: "2026-06-12T11:00:00Z",
        source: "qa"
      });

      expect(listExternalEvents(db).map((item) => item.id)).toEqual([
        newer.id,
        sameSecond.id,
        sameFirst.id,
        older.id
      ]);
    } finally {
      db.close();
    }
  });

  test("persists raw event fixtures and attachment metadata without secret values", async () => {
    const db = await openFixtureDatabase();
    try {
      const text = createExternalEvent(db, {
        content: "plain text message",
        event_type: "message",
        external_id: "msg-plain",
        occurred_at: "2026-07-06T01:00:00Z",
        provider: "fixture-provider",
        raw_json: { message: { text: "plain text message" }, token: "secret-token" },
        source: "fixture-im"
      });
      const mention = createExternalEvent(db, {
        content: "@PI please check",
        event_type: "message.mention",
        external_id: "msg-mention",
        occurred_at: "2026-07-06T01:01:00Z",
        provider: "fixture-provider",
        raw_json: { mentions: [{ id: "pi" }], text: "@PI please check" },
        source: "fixture-im"
      });
      const attachment = createExternalEvent(db, {
        attachments: [{
          kind: "image",
          mime: "image/png",
          name: "screen.png",
          remote_ref: "https://files.example/download/screen.png?token=secret-token",
          vision_summary: "A failing login screenshot"
        }],
        event_type: "message.attachment",
        external_id: "msg-attachment",
        occurred_at: "2026-07-06T01:02:00Z",
        provider: "fixture-provider",
        raw_json: { attachments: [{ file_key: "file-1" }], access_token: "secret-token" },
        source: "fixture-im"
      });
      const cli = createExternalEvent(db, {
        content: "bun test failed",
        event_type: "cli.output",
        external_id: "cli-run-1",
        occurred_at: "2026-07-06T01:03:00Z",
        provider: "cli",
        raw_json: { argv: ["bun", "test"], exit_code: 1, stderr: "expected 1 got 2" },
        source: "local-cli"
      });

      expect([text, mention, attachment, cli].map((item) => item.event_type)).toEqual([
        "message",
        "message.mention",
        "message.attachment",
        "cli.output"
      ]);
      expect(attachment.content).toBe("[1 attachment metadata item(s)]");
      expect(attachment.attachments).toEqual([{
        kind: "image",
        local_ref: "",
        mime_type: "image/png",
        name: "screen.png",
        ocr_text: "",
        remote_ref: "https://files.example/download/screen.png?token=%5Bredacted%5D",
        vision_summary: "A failing login screenshot"
      }]);
      expect(text.raw_json).toMatchObject({ token: "[redacted]" });
      expect(attachment.raw_json).toMatchObject({ access_token: "[redacted]" });
      expect(JSON.stringify(listExternalEvents(db))).not.toContain("secret-token");
    } finally {
      db.close();
    }
  });

  test("upserts repeated source external_id without duplicating raw events", async () => {
    const db = await openFixtureDatabase();
    try {
      const first = upsertExternalEvent(db, {
        content: "first delivery",
        event_type: "notification",
        external_id: "notice-1",
        source: "fixture-notify"
      });
      const replay = upsertExternalEvent(db, {
        content: "replayed delivery",
        event_type: "notification",
        external_id: "notice-1",
        source: "fixture-notify"
      });

      expect(replay.id).toBe(first.id);
      expect(replay.content).toBe("first delivery");
      expect(db.sqlite.query("select count(*) as count from external_events").get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-external-events-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}
