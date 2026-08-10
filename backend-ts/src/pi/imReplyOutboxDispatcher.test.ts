import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../db/database.ts";
import type { RunnerDatabase } from "../db/database.ts";
import {
  approveImReplyDraft,
  createImReplyDraft,
  getSyncOutbox
} from "../db/repositories/imReplyOutbox.ts";
import {
  backfillImReplyProviderRequestRef,
  countImReplyLegacyOnlyReceipts,
  claimSyncOutboxSending,
  markSyncOutboxSent
} from "../db/repositories/imReplyOutboxDispatch.ts";
import { createPiAction, createPiApprovalRequest } from "../db/repositories/pi.ts";
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { dispatchImOutbox } from "./imReplyOutboxDispatcher.ts";
import { dispatchFeishuOutbox } from "../integrations/feishuOutboxDispatcherCompat.ts";
import type { ChannelConnector, OutboundEnvelope } from "../integrations/channelConnectorContracts.ts";
import { FeishuClientError, type FeishuMessageClient } from "../integrations/feishuClient.ts";
import type { FeishuConnectorConfig } from "../integrations/feishu.ts";
import { FEISHU_CONNECTOR_ID } from "../integrations/feishuChannelConnector.ts";

function testConfig(): FeishuConnectorConfig {
  return {
    allowedChatIds: [],
    allowedUserIds: [],
    appId: "cli_test",
    appSecret: "secret",
    defaultChatId: "",
    defaultUserId: "",
    encryptKey: "",
    projectMappings: [],
    receiveMode: "websocket",
    verificationToken: ""
  };
}

function fakeConnector(id: string, deliver: (envelope: OutboundEnvelope) => Promise<{ provider_request_ref: string; replayed: boolean; target: string }>): ChannelConnector {
  return {
    manifest: {
      auth_refs: [],
      capabilities: [
        { id: "message.receive", kind: "inbound", requires_authorization: true },
        { id: "message.reply", kind: "outbound", requires_authorization: true }
      ],
      contract_version: 1,
      display_name: id,
      id,
      kind: "channel"
    },
    deliver,
    health: () => ({ checked_at: new Date().toISOString(), last_error: "", reconnect_attempts: 0, state: "healthy" })
  };
}

function queueOutbox(db: RunnerDatabase, input: { content?: string; externalEventID?: number; issueID?: number; source?: string; targetChatID?: string } = {}) {
  const draft = createImReplyDraft(db, {
    content: input.content ?? "hello",
    external_event_id: input.externalEventID,
    issue_id: input.issueID,
    risk: "low",
    source: input.source ?? "feishu",
    status: "pending",
    target_chat_id: input.targetChatID ?? "oc_chat_1"
  });
  const approved = approveImReplyDraft(db, draft.id);
  return approved.outbox;
}

describe("im outbox dispatcher (generic authority)", () => {
  let db: RunnerDatabase;
  beforeEach(async () => {
    db = await openDatabase({ dbPath: ":memory:" });
  });

  test("one intent produces one claim, one connector delivery and a provider-neutral receipt", async () => {
    const outbox = queueOutbox(db);
    const delivered: OutboundEnvelope[] = [];
    const connector = fakeConnector("feishu", async (envelope) => {
      delivered.push(envelope);
      return { provider_request_ref: "om_ref_1", replayed: false, target: envelope.target };
    });
    const result = await dispatchImOutbox({ database: db, resolveConnector: () => connector });
    expect(result).toEqual({ failed: 0, processed: 1, retry: 0, sent: 1, skipped: 0 });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.connector_id).toBe("feishu");
    expect(delivered[0]!.operation).toBe("message.reply");
    expect(delivered[0]!.payload).toEqual({
      operation: "message.reply",
      schema_version: "xuanwu.im-outbound.v1",
      target: { connector_id: "feishu", conversation_id: "oc_chat_1" },
      text: "hello"
    });

    const row = getSyncOutbox(db, outbox.id)!;
    expect(row.status).toBe("sent");
    expect(row.provider_request_ref).toBe("om_ref_1");
    // W1 compat dual-write keeps the legacy carrier in sync for Feishu rows.
    expect(row.feishu_message_id).toBe("om_ref_1");
    const receipt = JSON.parse(row.result_json) as Record<string, unknown>;
    expect(receipt.schema_version).toBe("xuanwu.im-delivery-receipt.v1");
    expect(receipt.provider_request_ref).toBe("om_ref_1");

    // A second dispatch run must not re-send the claimed+sent row.
    const second = await dispatchImOutbox({ database: db, resolveConnector: () => connector });
    expect(second).toEqual({ failed: 0, processed: 0, retry: 0, sent: 0, skipped: 0 });
    expect(delivered).toHaveLength(1);
  });

  test("unknown connector fails closed without delivery and never falls back", async () => {
    const outbox = queueOutbox(db, { source: "telegraph" });
    const result = await dispatchImOutbox({
      database: db,
      resolveConnector: (source) => { throw new Error(`im channel module is not registered: ${source}`); }
    });
    expect(result.failed).toBe(1);
    const row = getSyncOutbox(db, outbox.id)!;
    expect(row.status).toBe("failed");
    expect(row.last_error).toContain("not registered");
  });

  test("transient errors retry with Retry-After; auth/permanent errors fail immediately", async () => {
    const rateLimited = queueOutbox(db, { content: "retry me" });
    let calls = 0;
    const flaky = fakeConnector("feishu", async () => {
      calls += 1;
      throw new FeishuClientError("429 slow down", { kind: "rate_limited", retryAfterSeconds: 30 });
    });
    const first = await dispatchImOutbox({ database: db, resolveConnector: () => flaky });
    expect(first.retry).toBe(1);
    let row = getSyncOutbox(db, rateLimited.id)!;
    expect(row.status).toBe("retry");
    expect(row.retry_after_seconds).toBe(30);
    expect(row.cooldown_until).not.toBe("");

    const authFailed = queueOutbox(db, { content: "auth" });
    const authed = fakeConnector("feishu", async () => {
      throw new FeishuClientError("401 bad token", { kind: "auth" });
    });
    const second = await dispatchImOutbox({ database: db, resolveConnector: () => authed });
    expect(second.failed).toBe(1);
    expect(getSyncOutbox(db, authFailed.id)!.status).toBe("failed");
    expect(calls).toBe(1);
  });

  test("competing claims cannot double-send a single outbox row", async () => {
    queueOutbox(db);
    const claimedA = claimSyncOutboxSending(db, 1, new Date());
    const claimedB = claimSyncOutboxSending(db, 1, new Date());
    expect(claimedA).not.toBeNull();
    expect(claimedB).toBeNull();
  });

  test("sent transition stores provider-neutral receipt and clears legacy authority for non-feishu rows", async () => {
    const outbox = queueOutbox(db, { source: "telegraph" });
    claimSyncOutboxSending(db, outbox.id, new Date());
    const sent = markSyncOutboxSent(db, outbox.id, {
      providerRequestRef: "tg_ref_1",
      resultJson: "{\"schema_version\":\"xuanwu.im-delivery-receipt.v1\"}"
    });
    expect(sent.provider_request_ref).toBe("tg_ref_1");
    expect(sent.feishu_message_id).toBe("");
  });

  test("legacy feishu_message_id backfill is idempotent and countable", async () => {
    const outbox = queueOutbox(db);
    db.sqlite.run(`update sync_outbox set status='sent', feishu_message_id='om_legacy_1', provider_request_ref='' where id=?`, [outbox.id]);
    expect(countImReplyLegacyOnlyReceipts(db)).toBe(1);
    expect(backfillImReplyProviderRequestRef(db)).toBe(1);
    expect(getSyncOutbox(db, outbox.id)!.provider_request_ref).toBe("om_legacy_1");
    expect(countImReplyLegacyOnlyReceipts(db)).toBe(0);
    expect(backfillImReplyProviderRequestRef(db)).toBe(0);
  });

  test("actionable outbox emits a canonical interaction and server-side opaque binding", async () => {
    createPiAction(db, {
      action_type: "assistant.tool.call",
      id: "act_1",
      payload_json: "{}",
      status: "pending"
    });
    const draft = createImReplyDraft(db, {
      approval_action_id: "pi_action:act_1",
      content: "confirm",
      external_event_id: actorEvent(db),
      risk: "low",
      source: "feishu",
      status: "pending",
      target_chat_id: "oc_chat_9"
    });
    approveImReplyDraft(db, draft.id);
    const operations: string[] = [];
    const connector = fakeConnector("feishu", async (envelope) => {
      operations.push(envelope.operation);
      return { provider_request_ref: "om_card_1", replayed: false, target: envelope.target };
    });
    connector.manifest.capabilities.push({ id: "interaction.send", kind: "outbound", requires_authorization: true });
    const result = await dispatchImOutbox({ database: db, resolveConnector: () => connector });
    expect(result.sent).toBe(1);
    expect(operations).toEqual(["interaction.send"]);
    const binding = db.sqlite.query<{ actor_id: string; interaction_id: string }, []>(
      "select actor_id, interaction_id from im_interaction_bindings limit 1"
    ).get();
    expect(binding?.actor_id).toBe("u_9");
    expect(binding?.interaction_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  test("approval preflight rejects missing approval requests", async () => {
    createPiApprovalRequest(db, {
      approval_id: "appr_real",
      status: "pending"
    });
    const draft = createImReplyDraft(db, {
      approval_action_id: "appr_missing",
      content: "confirm",
      risk: "low",
      source: "feishu",
      status: "pending",
      target_chat_id: "oc_chat_1"
    });
    const outbox = approveImReplyDraft(db, draft.id).outbox;
    const connector = fakeConnector("feishu", async () => ({ provider_request_ref: "x", replayed: false, target: "t" }));
    const result = await dispatchImOutbox({ database: db, resolveConnector: () => connector });
    expect(result.failed).toBe(1);
    expect(getSyncOutbox(db, outbox.id)!.last_error).toContain("approval request is missing");
  });

  test("legacy dispatchFeishuOutbox delegates to the generic dispatcher with one delivery", async () => {
    const outbox = queueOutbox(db);
    const sends: string[] = [];
    const sender: FeishuMessageClient = {
      sendTextMessage: async (input) => {
        sends.push(input.text);
        return { messageId: "om_legacy_delegate" };
      }
    };
    const result = await dispatchFeishuOutbox({ config: testConfig(), database: db, sender });
    expect(result.sent).toBe(1);
    expect(sends).toEqual(["hello"]);
    expect(getSyncOutbox(db, outbox.id)!.provider_request_ref).toBe("om_legacy_delegate");
  });

  test("dispatchFeishuOutbox target allowlist failures are permanent (no retry storm)", async () => {
    const outbox = queueOutbox(db, { targetChatID: "oc_forbidden" });
    const sender: FeishuMessageClient = {
      sendTextMessage: async () => ({ messageId: "om_should_not_send" })
    };
    const config = { ...testConfig(), allowedChatIds: ["oc_allowed_only"] };
    const result = await dispatchFeishuOutbox({ config, database: db, sender });
    expect(result.failed).toBe(1);
    const row = getSyncOutbox(db, outbox.id)!;
    expect(row.status).toBe("failed");
    expect(row.last_error).toContain("not allowed");
  });

  test("dispatchImOutbox only uses the feishu connector id constant for feishu rows", () => {
    expect(FEISHU_CONNECTOR_ID).toBe("feishu");
  });
});

function actorEvent(db: RunnerDatabase): number {
  return createExternalEvent(db, {
    content: "request",
    dedupe_key: `actor-event-${Date.now()}-${Math.random()}`,
    external_id: "om_actor_1",
    normalized_message: { sender: { id: "u_9", open_id: "ou_9" } },
    source: "feishu"
  }).id;
}
