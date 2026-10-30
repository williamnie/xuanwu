import { describe, expect, test } from "bun:test";
import {
  classifyPiActionRisk,
  gatePiActionEnvelope
} from "./actionEngine.ts";
import type { PiGatePolicy } from "./actionGate.ts";



export function registerClassifiesSafeConfirmRequiredAndHigh() {
test("classifies safe, confirm-required, and high-risk actions", () => {
    expect(classifyPiActionRisk("issue.comment")).toEqual({
      gate: "safe",
      requiresConfirmation: false,
      riskLevel: "low"
    });
    expect(classifyPiActionRisk("issue.enqueue")).toEqual({
      gate: "confirm",
      requiresConfirmation: true,
      riskLevel: "medium"
    });
    expect(classifyPiActionRisk("issue.acceptance_request")).toEqual({
      gate: "confirm",
      requiresConfirmation: true,
      riskLevel: "medium"
    });
    expect(classifyPiActionRisk("human_review.respond")).toEqual({
      gate: "confirm",
      requiresConfirmation: true,
      riskLevel: "medium"
    });
    expect(classifyPiActionRisk("issue.cancel")).toEqual({
      gate: "confirm",
      requiresConfirmation: true,
      riskLevel: "medium"
    });
    expect(classifyPiActionRisk("issue.status_update")).toEqual({
      gate: "confirm",
      requiresConfirmation: true,
      riskLevel: "medium"
    });
    expect(classifyPiActionRisk("workspace.write_file")).toEqual({
      gate: "confirm",
      requiresConfirmation: true,
      riskLevel: "medium"
    });
    expect(classifyPiActionRisk("session.steer")).toEqual({
      gate: "high",
      requiresConfirmation: true,
      riskLevel: "high"
    });
    for (const actionType of ["issue.delete", "runner.settings_update", "system.restart"]) {
      expect(classifyPiActionRisk(actionType)).toEqual({
        gate: "high",
        requiresConfirmation: true,
        riskLevel: "high"
      });
    }
    expect(classifyPiActionRisk("runner.settings_read")).toEqual({
      gate: "safe",
      requiresConfirmation: false,
      riskLevel: "low"
    });
    expect(classifyPiActionRisk("work.cancel")).toEqual({
      gate: "high",
      requiresConfirmation: true,
      riskLevel: "high"
    });
    expect(classifyPiActionRisk("run.interrupt")).toEqual({
      gate: "safe",
      requiresConfirmation: false,
      riskLevel: "low"
    });
    expect(classifyPiActionRisk("mcp.resource.read")).toEqual({
      gate: "safe",
      requiresConfirmation: false,
      riskLevel: "low"
    });
    expect(classifyPiActionRisk("mcp.tool.call", { riskLevel: "high" })).toEqual({
      gate: "high",
      requiresConfirmation: true,
      riskLevel: "high"
    });
  });

test("gates attended confirmations and delegated authorization envelopes", () => {
    const confirmEnvelope = {
      action_type: "issue.enqueue",
      issue_id: 7,
      payload: { issue_id: 7 },
      project_id: "demo",
      rationale: "ready to run",
      requires_confirmation: true,
      risk_level: "medium",
      source: "pi_tool"
    } as const;

    expect(gatePiActionEnvelope(confirmEnvelope, { mode: "attended" })).toMatchObject({
      decision: "ask",
      reason: expect.stringContaining("confirmation")
    });
    expect(gatePiActionEnvelope({ ...confirmEnvelope, action_type: "issue.comment", requires_confirmation: false, risk_level: "low" }, {
      authorizedActions: [{ action_type: "issue.comment", issue_id: 7, project_id: "demo" }],
      mode: "delegated",
      scope: { project_id: "demo" }
    })).toMatchObject({ decision: "execute" });
    expect(gatePiActionEnvelope(confirmEnvelope, {
      authorizedActions: [{ action_type: "issue.enqueue", issue_id: 7, project_id: "demo" }],
      mode: "delegated",
      scope: { project_id: "demo" }
    })).toMatchObject({
      decision: "execute",
      reason: expect.stringContaining("authorization envelope")
    });
    expect(gatePiActionEnvelope(confirmEnvelope, {
      allowedActions: ["issue.enqueue"],
      askOnMissingAuthorization: true,
      authorizedActions: [{ action_type: "issue.read" }],
      mode: "delegated",
      scope: { project_id: "demo" }
    })).toMatchObject({
      decision: "ask",
      reason: expect.stringContaining("explicit user approval")
    });
    expect(gatePiActionEnvelope({
      ...confirmEnvelope,
      action_type: "run.interrupt",
      payload: { action: "interrupt", run_id: "xw:run:issue_runs:issue-7-attempt-1" },
      requires_confirmation: false,
      risk_level: "low"
    }, {
      authorizedActions: [{ action_type: "run.interrupt", issue_id: 7, project_id: "demo" }],
      mode: "delegated",
      scope: { project_id: "demo" }
    })).toMatchObject({
      decision: "execute",
      reason: expect.stringContaining("authorization envelope")
    });
    expect(gatePiActionEnvelope({
      ...confirmEnvelope,
      action_type: "run.interrupt",
      payload: { action: "interrupt", run_id: "xw:run:issue_runs:issue-7-attempt-1" },
      requires_confirmation: false,
      risk_level: "low"
    }, {
      allowedActions: ["run.interrupt"],
      mode: "attended",
      scope: { issue_id: 7, project_id: "demo" }
    })).toMatchObject({ decision: "execute" });
    const reconcileEnvelope = {
      ...confirmEnvelope,
      action_type: "issue.acceptance_request",
      payload: { issue_id: 7 }
    } as const;
    expect(gatePiActionEnvelope(reconcileEnvelope, {
      authorizedActions: [{ action_type: "issue.acceptance_request", issue_id: 7, project_id: "demo" }],
      mode: "delegated",
      scope: { project_id: "demo" }
    })).toMatchObject({ decision: "execute" });
    expect(gatePiActionEnvelope(reconcileEnvelope, {
      authorizedActions: [{ action_type: "issue.acceptance_request", issue_id: 8, project_id: "demo" }],
      mode: "delegated",
      scope: { project_id: "demo" }
    })).toMatchObject({ decision: "deny" });
    expect(gatePiActionEnvelope({ ...confirmEnvelope, action_type: "issue.comment", requires_confirmation: false, risk_level: "low" }, {
      authorizedActions: [{ action_type: "issue.comment", issue_id: 8, project_id: "demo" }],
      mode: "delegated",
      scope: { project_id: "demo" }
    })).toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("delegated")
    });
  });
}
