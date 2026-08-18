import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../database.ts";
import { adoptImConversationState, getImConversationState } from "./imConversationState.ts";
import {
  activateImContextRollover,
  failImContextProjectionReservation,
  getImContextCursor,
  prepareImContextRollover,
  reconcileReservedImContextBindings,
  reserveImContextProjection,
  markImContextProjectionPresented
} from "./imContextLifecycle.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("IM context lifecycle repositories", () => {
  test("reserves event bindings, advances independent cursors only after presentation, and records failures", async () => {
    const db = await fixture();
    try {
      const reservation = reserveImContextProjection(db, {
        connectorID: "feishu",
        conversationID: "feishu-chat-a",
        events: [
          { direction: "inbound", included: true, messageRef: "m1", projectionHash: "a".repeat(64), sourceRowID: 11 },
          { direction: "outbound", included: false, messageRef: "m2", projectionHash: "b".repeat(64), sourceRowID: 23 }
        ],
        scopeKey: "feishu-chat-a",
        turnID: "turn-1"
      });
      expect(reservation.accepted).toEqual([
        { direction: "inbound", sourceRowID: 11 },
        { direction: "outbound", sourceRowID: 23 }
      ]);
      expect(getImContextCursor(db, reservation)).toBeNull();

      markImContextProjectionPresented(db, reservation);
      expect(getImContextCursor(db, reservation)).toMatchObject({
        inbound_event_id: 11,
        outbound_outbox_id: 23
      });
      expect(db.sqlite.query<{ count: number }, []>(
        "select count(*) as count from im_context_event_bindings where status='presented'"
      ).get()?.count).toBe(2);

      const failed = reserveImContextProjection(db, {
        connectorID: "feishu", conversationID: "feishu-chat-a",
        events: [{ direction: "inbound", included: true, messageRef: "m3", projectionHash: "c".repeat(64), sourceRowID: 12 }],
        scopeKey: "feishu-chat-a", turnID: "turn-2"
      });
      failImContextProjectionReservation(db, failed, "preflight_failed");
      expect(getImContextCursor(db, reservation)?.inbound_event_id).toBe(11);
      expect(db.sqlite.query<{ status: string }, [string]>(
        "select status from im_context_event_bindings where turn_id=?"
      ).get("turn-2")?.status).toBe("failed");
      const retried = reserveImContextProjection(db, {
        connectorID: "feishu", conversationID: "feishu-chat-a",
        events: [{ direction: "inbound", included: true, messageRef: "m3", projectionHash: "c".repeat(64), sourceRowID: 12 }],
        scopeKey: "feishu-chat-a", turnID: "turn-3"
      });
      expect(retried.accepted).toEqual([{ direction: "inbound", sourceRowID: 12 }]);
      markImContextProjectionPresented(db, retried);
      expect(getImContextCursor(db, reservation)?.inbound_event_id).toBe(12);
      reserveImContextProjection(db, {
        connectorID: "feishu", conversationID: "feishu-chat-a",
        events: [{ direction: "outbound", included: true, messageRef: "m4", projectionHash: "d".repeat(64), sourceRowID: 24 }],
        scopeKey: "feishu-chat-a", turnID: "turn-crashed"
      });
      expect(reconcileReservedImContextBindings(db)).toBe(1);
      expect(db.sqlite.query<{ status: string }, [string]>(
        "select status from im_context_event_bindings where turn_id=?"
      ).get("turn-crashed")?.status).toBe("failed");
    } finally {
      db.close();
    }
  });

  test("activates one database CAS rollover and leaves a stale competitor failed", async () => {
    const db = await fixture();
    try {
      adoptImConversationState(db, {
        activeConversationId: "feishu-chat-a",
        baseConversationId: "feishu-chat-a",
        connectorId: "feishu",
        scopeKey: "feishu-chat-a"
      });
      const rollover = prepareImContextRollover(db, {
        baseConversationID: "feishu-chat-a",
        capsule: { parent_session_ref: "session-a", summary_unavailable: true },
        connectorID: "feishu",
        parentConversationID: "feishu-chat-a",
        parentEpoch: 0,
        scopeKey: "feishu-chat-a",
        trigger: "user_turn_count"
      });
      expect(activateImContextRollover(db, rollover.id)).toMatchObject({ activated: true });
      expect(getImConversationState(db, "feishu", "feishu-chat-a")).toMatchObject({
        active_conversation_id: "feishu-chat-a-n1",
        epoch: 1
      });

      const competitor = prepareImContextRollover(db, {
        baseConversationID: "feishu-chat-a",
        capsule: { summary_unavailable: true },
        connectorID: "feishu",
        parentConversationID: "feishu-chat-a-n1",
        parentEpoch: 1,
        scopeKey: "feishu-chat-a",
        trigger: "compaction_count"
      });
      db.sqlite.run("update im_context_rollovers set expected_active_conversation_id='stale' where id=?", [competitor.id]);
      expect(activateImContextRollover(db, competitor.id)).toMatchObject({ activated: false });
    } finally {
      db.close();
    }
  });
});

async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-im-context-lifecycle-"));
  roots.push(root);
  return await openDatabase({ stateDir: join(root, "state") });
}
