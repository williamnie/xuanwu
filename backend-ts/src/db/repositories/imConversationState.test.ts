import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunnerDatabase } from "../database.ts";
import { backfillImConversationState } from "../schema/070_im_conversation_state.ts";
import {
  adoptImConversationState,
  auditImConversationBackfill,
  bumpImConversationEpoch,
  getImConversationState
} from "./imConversationState.ts";
import { useTestDatabase } from "../../testing/harness.ts";

const openFixtureDatabase = useTestDatabase();

describe("IM conversation state repository", () => {
  test("stores per-connector scope epochs without any project binding", async () => {
    const db = await openFixtureDatabase();
    const first = bumpImConversationEpoch(db, {
      baseConversationId: "feishu-chat-oc_group",
      connectorId: "feishu",
      scopeKey: "feishu-chat-oc_group"
    }, new Date("2026-08-07T01:00:00Z"));
    const otherConnector = bumpImConversationEpoch(db, {
      baseConversationId: "im-telegram-abc",
      connectorId: "telegram",
      scopeKey: "telegram-chat-42",
      // same scope key on another connector must not collide
    }, new Date("2026-08-07T02:00:00Z"));

    expect(first).toMatchObject({
      active_conversation_id: "feishu-chat-oc_group-n1",
      base_conversation_id: "feishu-chat-oc_group",
      connector_id: "feishu",
      epoch: 1,
      scope_key: "feishu-chat-oc_group"
    });
    expect(otherConnector).toMatchObject({
      connector_id: "telegram",
      epoch: 1,
      scope_key: "telegram-chat-42"
    });
    expect(Object.keys(first).sort()).toEqual([
      "active_conversation_id",
      "base_conversation_id",
      "connector_id",
      "epoch",
      "scope_key",
      "started_at",
      "updated_at"
    ]);
  });

  test("keeps epochs isolated per connector and scope", async () => {
    const db = await openFixtureDatabase();
    bumpImConversationEpoch(db, {
      baseConversationId: "chat-a",
      connectorId: "feishu",
      scopeKey: "scope-a"
    });
    bumpImConversationEpoch(db, {
      baseConversationId: "chat-a",
      connectorId: "feishu",
      scopeKey: "scope-a"
    });
    const other = bumpImConversationEpoch(db, {
      baseConversationId: "chat-b",
      connectorId: "telegram",
      scopeKey: "scope-a"
    });
    const thread = bumpImConversationEpoch(db, {
      baseConversationId: "thread-a",
      connectorId: "feishu",
      scopeKey: "scope-thread"
    });

    expect(getImConversationState(db, "feishu", "scope-a")?.epoch).toBe(2);
    expect(other.epoch).toBe(1);
    expect(thread.epoch).toBe(1);
    expect(getImConversationState(db, "telegram", "scope-a")?.active_conversation_id).toBe("chat-b-n1");
  });

  test("adopts an existing scope once and never overwrites it", async () => {
    const db = await openFixtureDatabase();
    const adopted = adoptImConversationState(db, {
      activeConversationId: "feishu-chat-oc_group-20260720-n2",
      baseConversationId: "feishu-chat-oc_group",
      connectorId: "feishu",
      epoch: 2,
      scopeKey: "feishu-chat-oc_group",
      startedAt: "2026-07-20T09:00:00.000Z"
    }, new Date("2026-07-21T01:00:00Z"));
    const again = adoptImConversationState(db, {
      activeConversationId: "ignored",
      baseConversationId: "feishu-chat-oc_group",
      connectorId: "feishu",
      epoch: 0,
      scopeKey: "feishu-chat-oc_group"
    }, new Date("2026-07-21T02:00:00Z"));

    expect(adopted).toMatchObject({
      active_conversation_id: "feishu-chat-oc_group-20260720-n2",
      epoch: 2,
      started_at: "2026-07-20T09:00:00.000Z"
    });
    expect(again).toEqual(adopted);

    const bumped = bumpImConversationEpoch(db, {
      baseConversationId: "feishu-chat-oc_group",
      connectorId: "feishu",
      scopeKey: "feishu-chat-oc_group"
    }, new Date("2026-07-21T03:00:00Z"));
    expect(bumped).toMatchObject({
      active_conversation_id: "feishu-chat-oc_group-n3",
      epoch: 3,
      // bumping the epoch preserves the adopted scope start
      started_at: "2026-07-20T09:00:00.000Z"
    });
  });

  test("returns null for blank or unknown scopes", async () => {
    const db = await openFixtureDatabase();
    expect(getImConversationState(db, "", "scope")).toBeNull();
    expect(getImConversationState(db, "feishu", "")).toBeNull();
    expect(getImConversationState(db, "feishu", "missing")).toBeNull();
  });
});

describe("IM conversation state backfill", () => {
  test("backfills legacy Feishu rows idempotently and audits parity", async () => {
    const db = await openFixtureDatabase();
    seedLegacyRow(db, "feishu-chat-oc_a", "feishu-chat-oc_a-n2", 2);
    seedLegacyRow(db, "feishu-thread-omt_b", "feishu-thread-omt_b", 0);

    expect(backfillImConversationState(db.sqlite)).toBe(2);
    expect(backfillImConversationState(db.sqlite)).toBe(0);

    expect(getImConversationState(db, "feishu", "feishu-chat-oc_a")).toMatchObject({
      active_conversation_id: "feishu-chat-oc_a-n2",
      base_conversation_id: "feishu-chat-oc_a",
      connector_id: "feishu",
      epoch: 2,
      started_at: "2026-07-20T09:00:00.000Z"
    });
    expect(auditImConversationBackfill(db)).toEqual({
      feishu_rows: 2,
      im_feishu_rows: 2,
      missing_scopes: [],
      mismatched_scopes: []
    });
  });

  test("audit reports missing and diverged rows", async () => {
    const db = await openFixtureDatabase();
    seedLegacyRow(db, "feishu-chat-oc_missing", "feishu-chat-oc_missing", 0);
    seedLegacyRow(db, "feishu-chat-oc_diverged", "feishu-chat-oc_diverged-n1", 1);
    adoptImConversationState(db, {
      activeConversationId: "feishu-chat-oc_diverged-n7",
      baseConversationId: "feishu-chat-oc_diverged",
      connectorId: "feishu",
      epoch: 7,
      scopeKey: "feishu-chat-oc_diverged"
    });

    expect(auditImConversationBackfill(db)).toEqual({
      feishu_rows: 2,
      im_feishu_rows: 1,
      missing_scopes: ["feishu-chat-oc_missing"],
      mismatched_scopes: ["feishu-chat-oc_diverged"]
    });
  });
});

function seedLegacyRow(db: RunnerDatabase, scopeKey: string, activeConversationId: string, epoch: number): void {
  db.sqlite.run(
    `insert into feishu_conversation_state
       (scope_key, active_conversation_id, active_project_id, active_project_source, epoch, started_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [scopeKey, activeConversationId, "legacy-project", "card_select", epoch,
      "2026-07-20T09:00:00.000Z", "2026-07-20T09:00:00.000Z"]
  );
}
