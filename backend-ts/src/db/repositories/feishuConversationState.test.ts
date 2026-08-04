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
        started_at: "2026-06-13T02:00:00.000Z"
      });
      expect(getFeishuConversationState(db, "feishu-chat-oc_group-20260613")).toEqual(second);
    } finally {
      db.close();
    }
  });

  test("stores active project state for a Feishu conversation scope", async () => {
    const db = await openFixtureDatabase();
    try {
      const saved = setFeishuConversationActiveProject(db, {
        activeConversationId: "feishu-chat-oc_group-20260613",
        activeProjectId: "xuanwu",
        scopeKey: "feishu-chat-oc_group-20260613",
        source: "user_switch"
      }, new Date("2026-06-13T03:00:00Z"));
      const updated = setFeishuConversationActiveProject(db, {
        activeProjectId: "demo",
        scopeKey: "feishu-chat-oc_group-20260613",
        source: "issue_ref"
      }, new Date("2026-06-13T04:00:00Z"));

      expect(saved).toMatchObject({
        active_conversation_id: "feishu-chat-oc_group-20260613",
        active_project_id: "xuanwu",
        active_project_source: "user_switch",
        epoch: 0,
        scope_key: "feishu-chat-oc_group-20260613",
        started_at: "2026-06-13T03:00:00.000Z",
        updated_at: "2026-06-13T03:00:00.000Z"
      });
      expect(updated).toMatchObject({
        active_conversation_id: "feishu-chat-oc_group-20260613",
        active_project_id: "demo",
        active_project_source: "issue_ref",
        epoch: 0,
        scope_key: "feishu-chat-oc_group-20260613",
        started_at: "2026-06-13T03:00:00.000Z",
        updated_at: "2026-06-13T04:00:00.000Z"
      });
      expect(getFeishuConversationState(db, "feishu-chat-oc_group-20260613")).toEqual(updated);
    } finally {
      db.close();
    }
  });

  test("preserves active project state when starting a new conversation epoch", async () => {
    const db = await openFixtureDatabase();
    try {
      setFeishuConversationActiveProject(db, {
        activeConversationId: "feishu-chat-oc_group-20260613",
        activeProjectId: "xuanwu",
        scopeKey: "feishu-chat-oc_group-20260613",
        source: "card_select"
      }, new Date("2026-06-13T03:00:00Z"));

      const bumped = bumpFeishuConversationEpoch(db, {
        baseConversationId: "feishu-chat-oc_group-20260613",
        scopeKey: "feishu-chat-oc_group-20260613"
      }, new Date("2026-06-13T05:00:00Z"));

      expect(bumped).toMatchObject({
        active_conversation_id: "feishu-chat-oc_group-20260613-n1",
        active_project_id: "xuanwu",
        active_project_source: "card_select",
        epoch: 1,
        scope_key: "feishu-chat-oc_group-20260613",
        started_at: "2026-06-13T05:00:00.000Z",
        updated_at: "2026-06-13T05:00:00.000Z"
      });
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
