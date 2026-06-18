import { describe, expect, test } from "bun:test";
import { evaluateApprovalFastPolicy } from "./approvalFastPolicy.ts";

describe("approval fast policy", () => {
  test("returns deny-now for deterministic safety hits", () => {
    const decision = evaluateApprovalFastPolicy({
      method: "item/commandExecution/requestApproval",
      params: { command: "rm -rf CODEX_API_KEY=fixture-secret /Users/example/private", cwd: "/workspace/demo" }
    });

    if (decision.decision !== "deny-now") throw new Error("expected deny-now");
    const reason = decision.reason;
    expect(decision).toMatchObject({
      decision: "deny-now",
      resolver_decision: { decision: "deny" },
      reason: expect.stringContaining("CODEX_API_KEY=[redacted]"),
      rule_id: "pi_approval_deny_destructive_filesystem"
    });
    expect(reason.includes("fixture-secret")).toBe(false);
    expect(reason.includes("/Users/example")).toBe(false);
  });

  test("does not decide when deny-list does not match", () => {
    expect(evaluateApprovalFastPolicy({
      method: "item/commandExecution/requestApproval",
      params: { command: "cat README.md", cwd: "/workspace/demo" }
    })).toEqual({ decision: "none" });
  });
});
