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
    await flushTimers();
    expect(events).toEqual([expect.objectContaining({
      raw: expect.objectContaining({ method: "approval/fast_resolved" }),
      status: "approve"
    })]);
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
    await flushTimers();
    expect(events).toEqual([expect.objectContaining({
      raw: expect.objectContaining({ method: "approval/fast_resolved" }),
      status: "deny"
    })]);
    await expect(broker.resolveApproval("approval-deny-now", { decision: "approve" }))
      .rejects.toThrow("approval request is not pending");
  });

  test("declines unknown approvals immediately without creating pending approval state", async () => {
    const events: unknown[] = [];
    const broker = new CodexApprovalBroker({ onEvent: (event) => events.push(event) });

    await expect(broker.request(1, "item/commandExecution/requestApproval", {
      command: "git commit -m test",
      cwd: "/workspace/demo",
      itemId: "approval-unknown-now"
    })).resolves.toEqual({ decision: "decline" });

    expect(events).toEqual([]);
    await flushTimers();
    expect(events).toEqual([expect.objectContaining({
      raw: expect.objectContaining({ method: "approval/fast_resolved" }),
      status: "deny"
    })]);
    await expect(broker.resolveApproval("approval-unknown-now", { decision: "approve" }))
      .rejects.toThrow("approval request is not pending");
  });

  test("does not let fast audit hook failures affect resolved approvals", async () => {
    let hookCalls = 0;
    const broker = new CodexApprovalBroker({
      onEvent: () => {
        hookCalls += 1;
        throw new Error("audit unavailable");
      }
    });

    await expect(broker.request(1, "item/commandExecution/requestApproval", {
      command: "git status",
      cwd: "/workspace/demo",
      itemId: "approval-audit-throw"
    })).resolves.toEqual({ decision: "accept" });

    expect(hookCalls).toBe(0);
    await flushTimers();
    expect(hookCalls).toBe(1);
    await expect(broker.resolveApproval("approval-audit-throw", { decision: "approve" }))
      .rejects.toThrow("approval request is not pending");
  });
});

async function flushTimers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
