import { expect, test } from "bun:test";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { getPiAction } from "../../db/repositories/pi.ts";
import type { TestFixture } from "./feishuPiActionCards.testFixture.ts";

export function registerRejectsPiActionCallbacksFromCases(testScope: TestFixture) {
  const { fixtureHandler, createPendingPiAction, postFeishu, piActionCallback } = testScope;
  test("rejects PI action callbacks from unauthorized Feishu chats", async () => {
      const { database, handle } = await fixtureHandler({ allowedChatIds: "oc_allowed" });
      const issue = createIssue(database, { project_id: "demo", status: "triage", title: "PI action target" });
      createPendingPiAction(database, "pi-action-denied-chat", issue.id);
  
      const response = await postFeishu(
        handle,
        piActionCallback("pi-action-denied-chat", "approve", { chatId: "oc_denied" })
      );
  
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ message: "feishu approval callback is not allowed" });
      expect(getPiAction(database, "pi-action-denied-chat")).toMatchObject({ status: "pending" });
    });
}
