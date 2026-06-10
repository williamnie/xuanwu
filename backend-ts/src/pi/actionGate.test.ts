import { describe, expect, test } from "bun:test";
import { decidePiAuthorization, type PiActionEnvelope, type PiGatePolicy } from "./actionGate.ts";

const NOW = "2026-06-10T08:00:00Z";

describe("PI supervisor action gate", () => {
  test("executes authorized resume follow-up but keeps session steer high risk", () => {
    expect(decidePiAuthorization(envelope("session.resume_followup"), policy({
      allowed_actions: ["session.resume_followup"],
      authorizedActions: [{ action_type: "session.resume_followup", issue_id: 305, project_id: "demo" }],
      mode: "delegated"
    }))).toMatchObject({ decision: "execute" });

    expect(decidePiAuthorization(envelope("session.steer", "high", true), policy({
      allowed_actions: ["session.steer"],
      authorizedActions: [{ action_type: "session.steer", issue_id: 305, project_id: "demo" }],
      mode: "autonomous"
    }))).toMatchObject({
      decision: "ask",
      reason: expect.stringContaining("high-risk")
    });
  });

  test("denies exhausted recovery budget and snoozes cooldown windows before execution", () => {
    expect(decidePiAuthorization(envelope("session.resume_followup"), policy({
      allowed_actions: ["session.resume_followup"],
      authorizedActions: [{ action_type: "session.resume_followup", issue_id: 305, project_id: "demo" }],
      budget_remaining: 0,
      mode: "delegated"
    }))).toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("budget")
    });

    expect(decidePiAuthorization(envelope("session.resume_followup"), policy({
      allowed_actions: ["session.resume_followup"],
      authorizedActions: [{ action_type: "session.resume_followup", issue_id: 305, project_id: "demo" }],
      cooldown_until: "2026-06-10T08:05:00Z",
      mode: "delegated"
    }))).toMatchObject({
      decision: "snooze",
      reason: expect.stringContaining("cooldown")
    });
  });
});

function envelope(actionType: string, riskLevel: "low" | "medium" | "high" = "medium", confirm = true): PiActionEnvelope {
  return {
    action_type: actionType,
    issue_id: 305,
    payload: { issue_id: 305, prompt: "resume safely" },
    project_id: "demo",
    requires_confirmation: confirm,
    risk_level: riskLevel,
    source: "pi_supervisor"
  };
}

function policy(input: PiGatePolicy & { budget_remaining?: number; cooldown_until?: string }): PiGatePolicy {
  return { now: NOW, scope: { project_id: "demo" }, ...input } as PiGatePolicy;
}
