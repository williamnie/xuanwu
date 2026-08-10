import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/database.ts";
import { listImReplyDrafts, listSyncOutbox } from "../db/repositories/imReplyOutbox.ts";
import { createImOutboundEnvelope, type ImOutboundPayloadV1 } from "./imChannelContracts.ts";
import { deliverImOutboundNow } from "./imOutboundDelivery.ts";
import type { ChannelConnector } from "./channelConnectorContracts.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
});

describe("durable IM outbound delivery", () => {
  test("persists one draft/outbox and delivers once across an immediate replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "im-outbound-delivery-"));
    roots.push(root);
    const database = await openDatabase({ dbPath: join(root, "runner.db"), stateDir: root });
    try {
      let sends = 0;
      const connector = fakeConnector(async (envelope) => {
        sends += 1;
        return { provider_request_ref: "provider-message-1", replayed: false, target: envelope.target };
      });
      const payload: ImOutboundPayloadV1 = {
        operation: "message.reply",
        schema_version: "xuanwu.im-outbound.v1",
        target: { connector_id: "sample", conversation_id: "opaque-conversation" },
        text: "**Markdown** reply"
      };
      const envelope = createImOutboundEnvelope({
        actionGateRef: "policy:reply",
        actionID: "reply:1",
        authority: "deterministic_policy",
        correlationID: "event:1",
        eventRef: "external_events:1",
        idempotencyKey: "reply:event:1",
        payload,
        target: "sample://conversation/opaque-conversation"
      });
      const first = await deliverImOutboundNow({
        connector,
        content: payload.text!,
        database,
        envelope,
        externalEventId: 1,
        targetChatId: "opaque-conversation"
      });
      const replay = await deliverImOutboundNow({
        connector,
        content: payload.text!,
        database,
        envelope,
        externalEventId: 1,
        targetChatId: "opaque-conversation"
      });

      expect(first.replayed).toBe(false);
      expect(replay.replayed).toBe(true);
      expect(sends).toBe(1);
      expect(listImReplyDrafts(database)).toHaveLength(1);
      expect(listSyncOutbox(database)).toHaveLength(1);
      expect(JSON.parse(listSyncOutbox(database)[0]!.payload_json)).toMatchObject({
        connector_id: "sample",
        operation: "message.reply"
      });
    } finally {
      database.close();
    }
  });
});

function fakeConnector(deliver: NonNullable<ChannelConnector["deliver"]>): ChannelConnector {
  return {
    deliver,
    health: () => ({ checked_at: new Date().toISOString(), last_error: "", reconnect_attempts: 0, state: "healthy" }),
    ingest: () => undefined,
    manifest: {
      auth_refs: [],
      capabilities: [
        { id: "message.receive", kind: "inbound", requires_authorization: true },
        { id: "message.reply", kind: "outbound", requires_authorization: true }
      ],
      contract_version: 1,
      display_name: "Sample",
      id: "sample",
      kind: "channel"
    }
  };
}
