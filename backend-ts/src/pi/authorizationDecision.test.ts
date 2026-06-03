import { describe, expect, test } from "bun:test";
import { decidePiAuthorization, type PiActionEnvelope } from "./actionGate.ts";

const BASE: PiActionEnvelope = {
  action_type: "issue.comment",
  issue_id: 7,
  payload: {},
  project_id: "demo",
  requires_confirmation: false,
  risk_level: "low",
  source: "pi_tool"
};

describe("PI authorization decision", () => {
  test("manual mode asks instead of auto-executing safe actions", () => {
    expect(decidePiAuthorization(BASE, { mode: "manual" })).toMatchObject({
      decision: "ask"
    });
  });

  test("attended mode asks for confirm and high risk actions", () => {
    expect(decidePiAuthorization({ ...BASE, action_type: "issue.enqueue", requires_confirmation: true, risk_level: "medium" }, {
      mode: "attended"
    })).toMatchObject({ decision: "ask" });
    expect(decidePiAuthorization({ ...BASE, action_type: "session.steer", requires_confirmation: true, risk_level: "high" }, {
      mode: "attended"
    })).toMatchObject({ decision: "ask" });
  });

  test("delegated mode executes only actions covered by allowed_actions", () => {
    expect(decidePiAuthorization(BASE, {
      allowed_actions: ["issue.comment"],
      mode: "delegated"
    })).toMatchObject({ decision: "execute" });
    expect(decidePiAuthorization(BASE, {
      allowed_actions: ["issue.read"],
      mode: "delegated"
    })).toMatchObject({ decision: "deny" });
    expect(decidePiAuthorization(BASE, {
      allowed_actions: ["issue.comment"],
      authorizedActions: [{ action_type: "issue.comment", issue_id: 8, project_id: "demo" }],
      mode: "delegated"
    })).toMatchObject({ decision: "deny" });
    expect(decidePiAuthorization({ ...BASE, action_type: "sdk.read" }, {
      mode: "delegated"
    })).toMatchObject({ decision: "deny" });
  });

  test("forbidden actions and forbidden risk always deny", () => {
    expect(decidePiAuthorization(BASE, {
      allowed_actions: ["issue.comment"],
      authorizedActions: [{ action_type: "issue.comment", issue_id: 7, project_id: "demo" }],
      forbidden_actions: ["issue.comment"],
      mode: "delegated"
    })).toMatchObject({ decision: "deny" });
    expect(decidePiAuthorization({ ...BASE, risk_gate: "forbidden" } as PiActionEnvelope, {
      allowed_actions: ["issue.comment"],
      mode: "delegated"
    })).toMatchObject({ decision: "deny" });
    expect(decidePiAuthorization({ ...BASE, risk_level: "forbidden" } as unknown as PiActionEnvelope, {
      allowed_actions: ["issue.comment"],
      mode: "delegated"
    })).toMatchObject({ decision: "deny" });
  });

  test("delegation windows and scope mismatches block delegated execution", () => {
    expect(decidePiAuthorization(BASE, {
      allowed_actions: ["issue.comment"],
      mode: "delegated",
      now: "2026-06-03T10:00:00.000Z",
      starts_at: "2026-06-03T11:00:00.000Z"
    })).toMatchObject({ decision: "snooze" });
    expect(decidePiAuthorization(BASE, {
      allowed_actions: ["issue.comment"],
      expires_at: "2026-06-03T09:00:00.000Z",
      mode: "delegated",
      now: "2026-06-03T10:00:00.000Z"
    })).toMatchObject({ decision: "deny" });
    expect(decidePiAuthorization(BASE, {
      allowed_actions: ["issue.comment"],
      mode: "delegated",
      scope: { project_id: "other" }
    })).toMatchObject({ decision: "deny" });
  });
});
