import { expect, test } from "bun:test";
import type { ProviderEvent } from "../providers/types.ts";
import {
  ISSUE_LOG_BUDGET_MARKER_METHOD,
  ISSUE_LOG_LIFECYCLE_ROWS_PER_TYPE,
  ISSUE_LOG_PROTECTED_ROWS_PER_METHOD,
  createIssueLogPersistence
} from "./issueLogPersistence.ts";
import { session } from "./issueLogPersistenceTestFixtures.ts";

export function registerIssueLogPersistenceContinuation2Cases() {
  test("does not duplicate a complete final agent message when all deltas fit the budget", () => {
    const persisted: ProviderEvent[] = [];
    const persistence = createIssueLogPersistence((event) => persisted.push(event));
    persistence.push({ provider: "codex", type: "text", session, text: "complete answer", raw: { method: "item/agentMessage/delta", payload: "complete answer" } });
    persistence.push({
      provider: "codex",
      type: "raw",
      session,
      raw: { method: "item/completed", payload: JSON.stringify({ item: { id: "message-final", type: "agentMessage", text: "complete answer" } }) }
    });
    persistence.flush();

    expect(persisted.map((event) => event.text).filter(Boolean)).toEqual(["complete answer"]);
    expect(persisted.at(-1)).toMatchObject({
      payload: expect.objectContaining({ item_type: "agentMessage", raw_payload_omitted: true }),
      raw: { method: "item/completed" }
    });
  });

  test("bounds non-decisive lifecycle rows and fails closed on protected row overflow", () => {
    const lifecycle: ProviderEvent[] = [];
    const persistence = createIssueLogPersistence((event) => lifecycle.push(event));
    for (let index = 0; index < ISSUE_LOG_LIFECYCLE_ROWS_PER_TYPE + 20; index += 1) {
      persistence.push({
        provider: "codex",
        type: "raw",
        session,
        raw: { method: "item/started", payload: JSON.stringify({ item: { id: `reasoning-${index}`, type: "reasoning" } }) }
      });
    }
    persistence.push({ provider: "codex", type: "done", session, status: "completed", raw: { method: "turn/completed", payload: "completed" } });

    expect(lifecycle.filter((event) => event.raw?.method === "item/started")).toHaveLength(ISSUE_LOG_LIFECYCLE_ROWS_PER_TYPE);
    expect(lifecycle.find((event) => event.raw?.method === ISSUE_LOG_BUDGET_MARKER_METHOD)?.payload).toMatchObject({
      category: "lifecycle",
      omitted_events: 20
    });

    const protectedEvents: ProviderEvent[] = [];
    const protectedPersistence = createIssueLogPersistence((event) => protectedEvents.push(event));
    for (let index = 0; index < ISSUE_LOG_PROTECTED_ROWS_PER_METHOD; index += 1) {
      protectedPersistence.push({ provider: "codex", type: "raw", session, raw: { method: "approval/requested", payload: String(index) } });
    }
    expect(() => protectedPersistence.push({
      provider: "codex", type: "raw", session, raw: { method: "approval/requested", payload: "overflow" }
    })).toThrow("protected event budget exceeded");
    expect(protectedEvents.at(-1)?.payload).toMatchObject({ category: "protected", omitted_events: 1 });
  });
}
