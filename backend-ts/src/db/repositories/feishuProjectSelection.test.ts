import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumeFeishuPendingProjectSelection,
  createFeishuPendingProjectSelection,
  getFeishuPendingProjectSelection
} from "./feishuProjectSelection.ts";
import { useTestDatabase } from "../../testing/harness.ts";

const openFixtureDatabase = useTestDatabase();

describe("Feishu pending project selection repository", () => {
  test("stores a pending selection and consumes it only once", async () => {
    const db = await openFixtureDatabase();
    createFeishuPendingProjectSelection(db, {
      candidates: ["xuanwu", "demo"],
      chatId: "oc_group",
      conversationId: "feishu-chat-oc_group-20260613",
      expiresAt: "2026-06-13T02:00:00.000Z",
      originalPrompt: "开始做吧",
      scopeKey: "feishu-chat-oc_group-20260613",
      selectionId: "fps_1",
      sourceMessageId: "om_pending_1",
      userId: "ou_user_1",
      userOpenId: "ou_open_1"
    }, new Date("2026-06-13T01:00:00Z"));

    const first = consumeFeishuPendingProjectSelection(db, {
      chatId: "oc_group",
      now: new Date("2026-06-13T01:01:00Z"),
      projectId: "demo",
      selectionId: "fps_1",
      userId: "ou_user_1",
      userOpenId: "ou_open_1"
    });
    const second = consumeFeishuPendingProjectSelection(db, {
      chatId: "oc_group",
      now: new Date("2026-06-13T01:02:00Z"),
      projectId: "demo",
      selectionId: "fps_1",
      userId: "ou_user_1",
      userOpenId: "ou_open_1"
    });

    expect(first.status).toBe("consumed");
    expect(first.selection).toMatchObject({
      candidates: ["xuanwu", "demo"],
      original_prompt: "开始做吧",
      selected_project_id: "demo",
      status: "consumed"
    });
    expect(second.status).toBe("already_consumed");
    expect(getFeishuPendingProjectSelection(db, "fps_1"))?.toMatchObject({
      consumed_at: "2026-06-13T01:01:00.000Z",
      selected_project_id: "demo",
      status: "consumed"
    });
  });

  test("rejects mismatched callback source and invalid project choices", async () => {
    const db = await openFixtureDatabase();
    createFeishuPendingProjectSelection(db, {
      candidates: ["demo"],
      chatId: "oc_group",
      conversationId: "feishu-chat-oc_group-20260613",
      expiresAt: "2026-06-13T02:00:00.000Z",
      originalPrompt: "开始做吧",
      scopeKey: "feishu-chat-oc_group-20260613",
      selectionId: "fps_2",
      sourceMessageId: "om_pending_2",
      userId: "ou_user_1",
      userOpenId: "ou_open_1"
    }, new Date("2026-06-13T01:00:00Z"));

    expect(consumeFeishuPendingProjectSelection(db, {
      chatId: "oc_other",
      now: new Date("2026-06-13T01:01:00Z"),
      projectId: "demo",
      selectionId: "fps_2",
      userId: "ou_user_1",
      userOpenId: "ou_open_1"
    }).status).toBe("source_mismatch");
    expect(consumeFeishuPendingProjectSelection(db, {
      chatId: "oc_group",
      now: new Date("2026-06-13T01:01:00Z"),
      projectId: "other",
      selectionId: "fps_2",
      userId: "ou_user_1",
      userOpenId: "ou_open_1"
    }).status).toBe("invalid_project");
    expect(getFeishuPendingProjectSelection(db, "fps_2"))?.toMatchObject({ status: "pending" });
  });
});
