import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../database.ts";
import {
  bumpFeishuConversationEpoch,
  getFeishuConversationState
} from "./feishuConversationState.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Feishu conversation state repository", () => {
  test("stores and advances the active conversation epoch for a scope", async () => {
    const db = await openFixtureDatabase();
    try {
      const first = bumpFeishuConversationEpoch(db, {
        baseConversationId: "feishu-chat-oc_group-20260613",
        scopeKey: "feishu-chat-oc_group-20260613"
      }, new Date("2026-06-13T01:02:03Z"));
      const second = bumpFeishuConversationEpoch(db, {
        baseConversationId: "feishu-chat-oc_group-20260613",
        scopeKey: "feishu-chat-oc_group-20260613"
      }, new Date("2026-06-13T02:00:00Z"));

      expect(first).toMatchObject({
        active_conversation_id: "feishu-chat-oc_group-20260613-n1",
        epoch: 1,
        scope_key: "feishu-chat-oc_group-20260613",
        started_at: "2026-06-13T01:02:03.000Z"
      });
      expect(second).toMatchObject({
        active_conversation_id: "feishu-chat-oc_group-20260613-n2",
        epoch: 2,
        scope_key: "feishu-chat-oc_group-20260613",
        started_at: "2026-06-13T02:00:00.000Z"
      });
      expect(getFeishuConversationState(db, "feishu-chat-oc_group-20260613")).toEqual(second);
    } finally {
      db.close();
    }
  });

  test("returns null for blank or unknown scopes", async () => {
    const db = await openFixtureDatabase();
    try {
      expect(getFeishuConversationState(db, "")).toBeNull();
      expect(getFeishuConversationState(db, "missing")).toBeNull();
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-feishu-state-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}
