import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createExternalEvent, type ExternalEventAttachmentInput } from "../db/repositories/externalEvents.ts";
import { listContextBundles } from "../db/repositories/contextBundles.ts";
import { listIntakeRuns } from "../db/repositories/intakeRuns.ts";
import { getPiAction } from "../db/repositories/pi.ts";
import { runManualContextIntake } from "./manualTrigger.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("manual context intake trigger", () => {
  test("requires a source when multiple recent sources are available", async () => {
    const db = await openFixtureDatabase();
    try {
      event(db, "fixture-im", "m1", "群里有截图");
      event(db, "other-im", "m2", "另一个来源");

      const result = await runManualContextIntake(db, {
        now: "2026-07-06T01:10:00Z",
        user_prompt: "看看刚刚群里的截图和消息"
      });

      expect(result).toMatchObject({ reason: "source_required", status: "needs_user" });
      expect(result.text).toContain("请指定来源");
      expect(listContextBundles(db)).toEqual([]);
      expect(listIntakeRuns(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("creates ask_user proposal instead of assuming project when target is unclear", async () => {
    const db = await openFixtureDatabase();
    try {
      event(db, "fixture-im", "m1", "登录页 500 了");
      event(db, "fixture-im", "m2", "截图如下", [{ kind: "image", name: "login.png" }]);

      const result = await runManualContextIntake(db, {
        now: "2026-07-06T01:10:00Z",
        require_attachments: true,
        source: "fixture-im",
        user_prompt: "看看刚刚群里的截图和消息，是个 bug，创建 issue"
      });
      const action = getPiAction(db, result.proposal_actions?.[0]?.id ?? "");
      const payload = JSON.parse(action?.payload_json || "{}");

      expect(result).toMatchObject({ status: "succeeded" });
      expect(result.inbox_items?.[0]).toMatchObject({ primary_intent: "other" });
      expect(payload.action_proposals).toEqual([
        expect.objectContaining({ requires_approval: false, type: "ask_user" })
      ]);
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-manual-trigger-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function event(
  db: RunnerDatabase,
  source: string,
  externalID: string,
  content: string,
  attachments: ExternalEventAttachmentInput[] = []
): void {
  createExternalEvent(db, {
    attachments,
    content,
    external_id: externalID,
    normalized_message: {
      chat_id: "group-1",
      chat_type: "group",
      message_id: externalID,
      thread_id: "thread-a"
    },
    occurred_at: `2026-07-06T01:0${externalID.slice(1)}:00Z`,
    provider: source,
    raw_json: { text: content },
    received_at: `2026-07-06T01:0${externalID.slice(1)}:00Z`,
    source
  });
}
