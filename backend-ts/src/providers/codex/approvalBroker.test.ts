import { describe, expect, test } from "bun:test";
import { CodexApprovalBroker, codexProviderApprovalDecision } from "./approvalBroker.ts";

describe("Codex approval broker fast policy", () => {
  test("rejects unknown approval methods instead of using a compatibility default", async () => {
    const broker = new CodexApprovalBroker();

    expect(broker.canHandle("approval/resolve")).toBe(false);
    await expect(broker.request("rpc-unknown", "approval/resolve", {}))
      .rejects.toThrow("unsupported approval method: approval/resolve");
  });

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
      payload: expect.objectContaining({
        scope: "turn",
        session_grant_reusable: false,
        session_grant_ttl_ms: 0
      }),
      raw: expect.objectContaining({ method: "approval/fast_resolved" }),
      runEvent: expect.objectContaining({
        contract: "xw.run-event.v1",
        kind: "approval_resolved",
        outcome: "running",
        terminal: false
      }),
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

  test("keeps current-workspace write commands pending for explicit user approval", async () => {
    const events: unknown[] = [];
    const broker = new CodexApprovalBroker({ onEvent: (event) => events.push(event) });

    const pending = broker.request(1, "item/commandExecution/requestApproval", {
      command: "git commit -m test",
      cwd: "/workspace/demo",
      itemId: "approval-unknown-now"
    });

    expect(events).toEqual([expect.objectContaining({
      raw: expect.objectContaining({ method: "approval/requested" }),
      status: "pending"
    })]);
    await broker.resolveApproval("approval-unknown-now", { decision: "approve", scope: "turn" });
    await expect(pending).resolves.toEqual({ decision: "accept" });
    expect(events.at(-1)).toEqual(expect.objectContaining({
      raw: expect.objectContaining({ method: "approval/resolved" }),
      status: "approve"
    }));
  });

  test("routes scoped rm -rf commands to the pending approval channel", async () => {
    const events: unknown[] = [];
    const broker = new CodexApprovalBroker({ onEvent: (event) => events.push(event) });
    const pending = broker.request(2, "item/commandExecution/requestApproval", {
      command: "rm -rf *.mp4",
      cwd: "/workspace/demo",
      itemId: "approval-rm-video"
    });

    expect(events).toEqual([expect.objectContaining({
      raw: expect.objectContaining({ method: "approval/requested" }),
      status: "pending"
    })]);
    await broker.resolveApproval("approval-rm-video", { decision: "reject", scope: "turn" });
    await expect(pending).resolves.toEqual({ decision: "decline" });
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

  test("downgrades approve-for-session to current-turn approval when provider semantics are opaque", () => {
    expect(codexProviderApprovalDecision({
      decision: "approve_session",
      scope: "session"
    })).toEqual({ decision: "approve", scope: "turn" });
  });

  test("keeps explicit turn approval on the current turn", () => {
    expect(codexProviderApprovalDecision({
      decision: "approve",
      scope: "turn"
    })).toEqual({ decision: "approve", scope: "turn" });
  });
});

async function flushTimers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
