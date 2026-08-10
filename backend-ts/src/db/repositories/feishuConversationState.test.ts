import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../database.ts";
import {
  bumpFeishuConversationEpoch,
  getFeishuConversationState,
  setFeishuConversationActiveProject
} from "./feishuConversationState.ts";
import { getImConversationState } from "./imConversationState.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Feishu conversation state repository (W1 compatibility shim)", () => {
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
        active_project_id: "",
        active_project_source: "",
        epoch: 1,
        scope_key: "feishu-chat-oc_group-20260613",
        started_at: "2026-06-13T01:02:03.000Z"
      });
      expect(second).toMatchObject({
        active_conversation_id: "feishu-chat-oc_group-20260613-n2",
        active_project_id: "",
        active_project_source: "",
        epoch: 2,
        scope_key: "feishu-chat-oc_group-20260613",
        // The epoch scope keeps its original start across bumps; only
        // updated_at advances.
        started_at: "2026-06-13T01:02:03.000Z",
        updated_at: "2026-06-13T02:00:00.000Z"
      });
      expect(getFeishuConversationState(db, "feishu-chat-oc_group-20260613")).toEqual(second);

      // The provider-neutral table is the single application writer.
      expect(getImConversationState(db, "feishu", "feishu-chat-oc_group-20260613")).toMatchObject({
        active_conversation_id: "feishu-chat-oc_group-20260613-n2",
        base_conversation_id: "feishu-chat-oc_group-20260613",
        connector_id: "feishu",
        epoch: 2
      });
      // The legacy table is a read-only historical carrier during W1.
      expect(db.sqlite.query<{ count: number }, []>(
        "select count(*) as count from feishu_conversation_state"
      ).get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  test("never persists an active project; the legacy writer is a no-op", async () => {
    const db = await openFixtureDatabase();
    try {
      bumpFeishuConversationEpoch(db, {
        baseConversationId: "feishu-chat-oc_group-20260613",
        scopeKey: "feishu-chat-oc_group-20260613"
      }, new Date("2026-06-13T01:02:03Z"));

      const returned = setFeishuConversationActiveProject(db, {
        activeConversationId: "feishu-chat-oc_group-20260613",
        activeProjectId: "xuanwu",
        scopeKey: "feishu-chat-oc_group-20260613",
        source: "user_switch"
      }, new Date("2026-06-13T03:00:00Z"));

      // The shim keeps the legacy return shape but the epoch state is
      // unchanged and no project is persisted anywhere.
      expect(returned).toMatchObject({
        active_conversation_id: "feishu-chat-oc_group-20260613-n1",
        active_project_id: "",
        active_project_source: "",
        epoch: 1
      });
      const state = getFeishuConversationState(db, "feishu-chat-oc_group-20260613");
      expect(state).toMatchObject({
        active_conversation_id: "feishu-chat-oc_group-20260613-n1",
        active_project_id: "",
        active_project_source: "",
        epoch: 1
      });
      expect(db.sqlite.query<{ count: number }, []>(
        "select count(*) as count from feishu_conversation_state"
      ).get()).toEqual({ count: 0 });
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
  const root = await mkdtemp(join(tmpdir(), "xuanwu-feishu-state-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}
