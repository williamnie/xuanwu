import { describe, expect, test } from "bun:test";
import {
  IM_CAPABILITY_IDS,
  createImChannelRegistry,
  imDeliveryReceipt,
  imDeliveryReceiptResultJson,
  imOutboundPayloadFromEnvelope,
  validateImInboundMessage,
  validateImOutboundPayload,
  validateImTarget,
  type ImChannelModule,
  type ImInboundMessageV1,
  type ImOutboundPayloadV1
} from "./imChannelContracts.ts";
import type { ChannelConnector, OutboundEnvelope } from "./channelConnectorContracts.ts";

function validMessage(): ImInboundMessageV1 {
  return {
    attachments: [],
    connector_id: "fake",
    conversation: { id: "chat-1", kind: "group" },
    mentions: [],
    message_id: "m-1",
    occurred_at: "2026-08-07T00:00:00.000Z",
    raw_event_ref: "raw:1",
    schema_version: "xuanwu.im-message.v1",
    sender: { id: "u-1", kind: "user" },
    text: "hello",
    update_id: "u-1"
  };
}

function validPayload(): ImOutboundPayloadV1 {
  return {
    operation: "message.reply",
    schema_version: "xuanwu.im-outbound.v1",
    target: { connector_id: "fake", conversation_id: "chat-1" },
    text: "reply"
  };
}

function fakeConnector(id: string, capabilities: Array<{ id: string; kind: "inbound" | "outbound" }>): ChannelConnector {
  return {
    manifest: {
      auth_refs: [],
      capabilities: capabilities.map((item) => ({ ...item, requires_authorization: true })),
      contract_version: 1,
      display_name: id,
      id,
      kind: "channel"
    },
    health: () => ({ checked_at: new Date().toISOString(), last_error: "", reconnect_attempts: 0, state: "healthy" }),
    ingest: () => undefined,
    deliver: async () => ({ provider_request_ref: "ref-1", replayed: false, target: "t" })
  };
}

function fakeModule(id: string, connector?: ChannelConnector): ImChannelModule {
  return {
    configuration: { fields: [], mode: "none", settings_path: "" },
    connector: connector ?? fakeConnector(id, [
      { id: "message.receive", kind: "inbound" },
      { id: "message.reply", kind: "outbound" }
    ]),
    id,
    presentation: { deliver: async () => ({ provider_request_ref: "r", replayed: false, target: "t" }) },
    receiver: {
      restart: () => undefined,
      start: () => undefined,
      status: () => ({
        connected: false,
        connector_id: id,
        last_error: "",
        last_event_at: "",
        reconnect_attempts: 0,
        state: "disabled"
      }),
      stop: () => undefined
    }
  };
}

describe("generic im channel contracts", () => {
  test("IM capability vocabulary excludes card.send", () => {
    expect(IM_CAPABILITY_IDS).toContain("interaction.send");
    expect(IM_CAPABILITY_IDS).toContain("thread.reply");
    expect(IM_CAPABILITY_IDS).not.toContain("card.send");
  });

  test("accepts a canonical inbound message with opaque ids and unknown metadata tolerance", () => {
    expect(validateImInboundMessage(validMessage()).ok).toBe(true);
  });

  test("rejects inbound message without message id, with bad kind, or non-ISO timestamp", () => {
    expect(validateImInboundMessage({ ...validMessage(), message_id: "" }).ok).toBe(false);
    expect(validateImInboundMessage({ ...validMessage(), conversation: { id: "c", kind: "spaceship" } }).ok).toBe(false);
    expect(validateImInboundMessage({ ...validMessage(), occurred_at: "1723000000" }).ok).toBe(false);
    expect(validateImInboundMessage({ ...validMessage(), schema_version: "v0" }).ok).toBe(false);
  });

  test("target validation keeps ids opaque and rejects empty conversation id", () => {
    expect(validateImTarget({ connector_id: "fake", conversation_id: "oc_prefix_kept" }).ok).toBe(true);
    expect(validateImTarget({ connector_id: "fake", conversation_id: "" }).ok).toBe(false);
  });

  test("outbound payload requires canonical operation and matching envelope operation", () => {
    expect(validateImOutboundPayload(validPayload()).ok).toBe(true);
    expect(validateImOutboundPayload({ ...validPayload(), operation: "card.send" }).ok).toBe(false);
    expect(validateImOutboundPayload({ ...validPayload(), text: "" }).ok).toBe(false);
    const envelope = { operation: "reaction.add", payload: validPayload() as unknown as Record<string, unknown> };
    expect(() => imOutboundPayloadFromEnvelope(envelope as OutboundEnvelope)).toThrow(/does not match/);
    const okEnvelope = { operation: "message.reply", payload: validPayload() as unknown as Record<string, unknown> };
    expect(imOutboundPayloadFromEnvelope(okEnvelope as OutboundEnvelope).text).toBe("reply");
  });

  test("interaction.send payload validates the canonical interaction", () => {
    const interactionPayload = {
      interaction: {
        actions: [{ action_id: "a1", label: "Approve", style: "primary" }],
        body: "body",
        expires_at: "2026-08-08T00:00:00.000Z",
        interaction_id: "tok",
        kind: "approval",
        revision: 1,
        schema_version: "xuanwu.im-interaction.v1",
        title: "title"
      },
      operation: "interaction.send",
      schema_version: "xuanwu.im-outbound.v1",
      target: { connector_id: "fake", conversation_id: "c" }
    };
    expect(validateImOutboundPayload(interactionPayload).ok).toBe(true);
    const bad = {
      ...interactionPayload,
      interaction: { ...interactionPayload.interaction, actions: [
        { action_id: "a1", label: "A", style: "primary" },
        { action_id: "a1", label: "B", style: "danger" }
      ] }
    };
    expect(validateImOutboundPayload(bad).ok).toBe(false);
  });

  test("registry registers a module and resolves it by connector id", () => {
    const registry = createImChannelRegistry();
    registry.register(fakeModule("fake"));
    expect(registry.has("fake")).toBe(true);
    expect(registry.get("fake").connector.manifest.id).toBe("fake");
    expect(registry.list()).toHaveLength(1);
  });

  test("registry fails closed on duplicate id, manifest mismatch and unknown connector", () => {
    const registry = createImChannelRegistry();
    registry.register(fakeModule("fake"));
    expect(() => registry.register(fakeModule("fake"))).toThrow(/already registered/);
    expect(() => registry.register(fakeModule("other", fakeConnector("mismatch", [
      { id: "message.receive", kind: "inbound" },
      { id: "message.reply", kind: "outbound" }
    ])))).toThrow(/does not match connector manifest id/);
    expect(() => registry.get("unknown")).toThrow(/not registered/);
  });

  test("registry requires declared capabilities and a presentation adapter", () => {
    const registry = createImChannelRegistry({ require: ["message.receive", "message.reply", "interaction.send"] });
    expect(() => registry.register(fakeModule("fake"))).toThrow(/missing required capability interaction.send/);
    const noPresentation = { ...fakeModule("fake2") } as Record<string, unknown>;
    delete noPresentation.presentation;
    expect(() => createImChannelRegistry().register(noPresentation as unknown as ImChannelModule)).toThrow(/missing presentation/);
  });

  test("registry rejects readable secrets and malformed configuration schemas", () => {
    const readableSecret = fakeModule("secret");
    readableSecret.configuration.fields.push({
      id: "token", kind: "secret", label: "Token", required: true, write_only: false
    });
    expect(() => createImChannelRegistry().register(readableSecret)).toThrow(/must be write-only/);

    const duplicate = fakeModule("duplicate");
    duplicate.configuration.fields.push(
      { id: "mode", kind: "string", label: "Mode", required: false, write_only: false },
      { id: "mode", kind: "string", label: "Again", required: false, write_only: false }
    );
    expect(() => createImChannelRegistry().register(duplicate)).toThrow(/invalid configuration field id/);
  });

  test("delivery receipt carries provider-neutral refs and bounded result json", () => {
    const receipt = imDeliveryReceipt({
      connector_id: "fake",
      provider_request_ref: "req-1",
      target: "fake://chat/c1"
    });
    expect(receipt.schema_version).toBe("xuanwu.im-delivery-receipt.v1");
    expect(receipt.provider_message_refs).toEqual(["req-1"]);
    const json = JSON.parse(imDeliveryReceiptResultJson(receipt));
    expect(json.provider_request_ref).toBe("req-1");
    expect(json.schema_version).toBe("xuanwu.im-delivery-receipt.v1");
  });
});
