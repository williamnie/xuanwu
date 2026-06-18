import { describe, expect, test } from "bun:test";
import { normalizePiActionEnvelope } from "./actionEnvelope.ts";

describe("PI action envelope normalize", () => {
  test("normalizes stable action, risk, source, rationale, and runtime links", () => {
    const envelope = normalizePiActionEnvelope({
      action_type: " issue.enqueue ",
      delegation_id: " delegation-a ",
      guardian_decision_id: " decision-a ",
      heartbeat_id: " heartbeat-a ",
      idempotency_key: " action-key-a ",
      payload: { issue_id: 7, note: "ready" },
      project_id: " demo ",
      rationale: " ready to run ",
      risk: { level: "medium", requires_confirmation: true },
      source: " pi_heartbeat ",
      snoozed_until: " 2026-06-03T12:00:00Z "
    });

    expect(envelope).toEqual({
      action_type: "issue.enqueue",
      delegation_id: "delegation-a",
      guardian_decision_id: "decision-a",
      heartbeat_id: "heartbeat-a",
      idempotency_key: "action-key-a",
      issue_id: 7,
      payload: { issue_id: 7, note: "ready" },
      project_id: "demo",
      rationale: "ready to run",
      requires_confirmation: true,
      risk: { gate: "confirm", level: "medium", requires_confirmation: true },
      risk_gate: "confirm",
      risk_level: "medium",
      snoozed_until: "2026-06-03T12:00:00Z",
      source: "pi_heartbeat"
    });
  });

  test("rejects missing required fields", () => {
    expect(() => normalizePiActionEnvelope({ payload: {}, source: "pi_tool" }))
      .toThrow("action_type is required");
    expect(() => normalizePiActionEnvelope({ action_type: "issue.comment", source: "pi_tool" }))
      .toThrow("payload is required");
    expect(() => normalizePiActionEnvelope({ action_type: "issue.comment", payload: {} }))
      .toThrow("source is required");
  });

  test("rejects payloads that cannot be represented as stable JSON", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => normalizePiActionEnvelope({
      action_type: "issue.comment",
      payload: { body: undefined },
      source: "pi_tool"
    })).toThrow("payload must be JSON serializable");
    expect(() => normalizePiActionEnvelope({
      action_type: "issue.comment",
      payload: { count: Number.NaN },
      source: "pi_tool"
    })).toThrow("payload must be JSON serializable");
    expect(() => normalizePiActionEnvelope({
      action_type: "issue.comment",
      payload: circular,
      source: "pi_tool"
    })).toThrow("payload must be JSON serializable");
  });
});
