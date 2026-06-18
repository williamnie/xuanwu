import { describe, expect, test } from "bun:test";
import { CodexApprovalBroker } from "./approvalBroker.ts";

describe("Codex approval broker fast policy", () => {
  test("accepts exact low-risk approvals once without creating pending approval state", async () => {
    const events: unknown[] = [];
    const broker = new CodexApprovalBroker({ onEvent: (event) => events.push(event) });

    await expect(broker.request(1, "item/commandExecution/requestApproval", {
      command: "git status",
      cwd: "/workspace/demo",
      itemId: "approval-approve-now"
    })).resolves.toEqual({ decision: "accept" });

    expect(events).toEqual([]);
    await expect(broker.resolveApproval("approval-approve-now", { decision: "approve" }))
      .rejects.toThrow("approval request is not pending");
  });

  test("declines deny-list approvals without creating pending approval state", async () => {
    const events: unknown[] = [];
    const broker = new CodexApprovalBroker({ onEvent: (event) => events.push(event) });

    await expect(broker.request(1, "item/commandExecution/requestApproval", {
      command: "sudo id",
      cwd: "/workspace/demo",
      itemId: "approval-deny-now"
    })).resolves.toEqual({ decision: "decline" });

    expect(events).toEqual([]);
    await expect(broker.resolveApproval("approval-deny-now", { decision: "approve" }))
      .rejects.toThrow("approval request is not pending");
  });
});
