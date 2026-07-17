import { describe, expect, test } from "bun:test";
import {
  assertConnectorConformance,
  assertOutboundEnvelope,
  redactConnectorValue,
  validateConnectorHealth,
  validateInboundEnvelope,
  validateOutboundEnvelope,
  type ChannelConnector,
  type ConnectorManifest,
  type InboundEnvelope,
  type OutboundEnvelope
} from "./channelConnectorContracts.ts";

const manifest: ConnectorManifest = {
  auth_refs: [{ kind: "secret_ref", ref: "secrets://connectors/fake/app" }],
  capabilities: [
    { id: "message.text", kind: "inbound", requires_authorization: false },
    { id: "message.send", kind: "outbound", requires_authorization: true }
  ],
  contract_version: 1,
  display_name: "Fake connector",
  id: "fake",
  kind: "channel"
};

const audit = {
  action_id: "pi-action:1",
  correlation_id: "correlation:1",
  event_ref: "pi_action_events:1",
  idempotency_key: "connector:fake:1",
  occurred_at: "2026-07-18T00:00:00.000Z"
};

function inbound(): InboundEnvelope {
  return {
    audit,
    connector_id: "fake",
    cursor: { connector_id: "fake", position: "42", scope: "chat:1" },
    event_id: "event:42",
    event_type: "message.text",
    occurred_at: "2026-07-18T00:00:00.000Z",
    payload: { text: "hello" },
    source: "fake"
  };
}

function outbound(): OutboundEnvelope {
  return {
    audit,
    authorization: { action_gate_ref: "pi_actions:1", authority: "human_approval", decision: "allow" },
    connector_id: "fake",
    idempotency_key: "connector:fake:send:1",
    operation: "message.send",
    payload: { text: "done" },
    target: "fake://chat/1"
  };
}

describe("P09.01 Channel / Connector contract", () => {
  test("fake connector satisfies manifest conformance and round-trips an inbound cursor", async () => {
    const received: InboundEnvelope[] = [];
    const fake: ChannelConnector = {
      manifest,
      health: () => ({ checked_at: "2026-07-18T00:00:00.000Z", last_error: "", reconnect_attempts: 0, state: "healthy" }),
      ingest: (event) => { received.push(event); },
      deliver: async (event) => ({ provider_request_ref: `fake:${event.idempotency_key}`, replayed: false, target: event.target })
    };
    assertConnectorConformance(fake);
    expect(validateInboundEnvelope(inbound(), manifest)).toEqual({ errors: [], ok: true });
    await fake.ingest!(inbound());
    expect(received[0].cursor).toEqual({ connector_id: "fake", position: "42", scope: "chat:1" });
    expect(await fake.deliver!(outbound())).toMatchObject({ replayed: false, target: "fake://chat/1" });
  });

  test("unknown inbound events and untrusted outbound authorizations fail closed", () => {
    const unknown = { ...inbound(), event_type: "unknown.event" };
    expect(validateInboundEnvelope(unknown, manifest).errors).toContain("inbound.event_type is not declared by manifest");

    const untrusted = { ...outbound(), authorization: { action_gate_ref: "llm:1", authority: "llm", decision: "allow" } };
    expect(validateOutboundEnvelope(untrusted, manifest).errors).toContain("outbound.authorization.authority is not trusted");
    expect(() => assertOutboundEnvelope(untrusted, manifest)).toThrow("invalid outbound connector envelope");
  });

  test("disconnect and recovery health are observable without changing connector state", () => {
    expect(validateConnectorHealth({
      checked_at: "2026-07-18T00:00:00.000Z", last_error: "network unavailable", reconnect_attempts: 2, state: "disconnected"
    })).toEqual({ errors: [], ok: true });
    expect(validateConnectorHealth({
      checked_at: "2026-07-18T00:01:00.000Z", last_error: "", reconnect_attempts: 2, state: "healthy"
    })).toEqual({ errors: [], ok: true });
  });

  test("redacts secrets from connector status and audit values", () => {
    expect(redactConnectorValue({ access_token: "Bearer super-secret", nested: { password: "p", text: "token=abc" } }))
      .toEqual({ access_token: "[redacted]", nested: { password: "[redacted]", text: "token=[redacted]" } });
    expect(validateConnectorHealth({
      checked_at: "2026-07-18T00:00:00.000Z", last_error: "Bearer super-secret", reconnect_attempts: 1, state: "failed"
    }).ok).toBe(false);
  });
});
