import { describe, expect, test } from "bun:test";
import { CodexAdapter, CodexThreadLifecycleError } from "./adapter.ts";
import type { JsonRpcParams } from "./jsonRpc.ts";

import { FakeRpc } from "./adapterTestFixtures.ts";

export function registerReadsLightweightThreadMetadataAndPaginates() {
test("reads lightweight thread metadata and paginates summarized turns", async () => {
    const rpc = new FakeRpc({
      "thread/read": { thread: { id: "thread-1", turns: [] } },
      "thread/turns/list": {
        data: [{ id: "turn-2", items: [{ type: "agentMessage", text: "summary" }] }],
        nextCursor: "older"
      }
    });
    const adapter = new CodexAdapter(rpc);

    await adapter.readThread("thread-1", { includeTurns: false });
    const turns = await adapter.listThreadTurns("thread-1", {
      itemsView: "summary",
      limit: 20,
      sortDirection: "desc"
    });

    expect(turns).toMatchObject({ data: [{ id: "turn-2" }], nextCursor: "older" });
    expect(rpc.calls).toEqual([
      { method: "thread/read", params: { threadId: "thread-1", includeTurns: false } },
      { method: "thread/turns/list", params: {
        threadId: "thread-1",
        itemsView: "summary",
        limit: 20,
        sortDirection: "desc"
      } }
    ]);
  });

test("starts turns with issue prompt input and normalized runtime options", async () => {
    const rpc = new FakeRpc({
      "turn/start": { turn: { id: "turn-1" } }
    });
    const result = await new CodexAdapter(rpc).startTurn("thread-1", [{
      type: "text",
      text: "issue prompt",
      text_elements: []
    }], {
      model: "codex-default",
      reasoningEffort: "xhigh",
      serviceTier: "priority",
      approvalPolicy: "danger-only",
      sandbox: "read-only"
    });

    expect(rpc.calls[0]).toEqual({
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "issue prompt", text_elements: [] }],
        effort: "xhigh",
        serviceTier: "priority",
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "readOnly" }
      }
    });
    expect(result).toEqual({
      provider: "codex",
      provider_session_id: "thread-1",
      sessionId: "thread-1",
      turn_id: "turn-1"
    });
  });

test("steers an active session turn through the current Codex RPC contract", async () => {
    const rpc = new FakeRpc({ "turn/steer": { turnId: "turn-active" } });

    const result = await new CodexAdapter(rpc).steerTurn("thread-1", "turn-active", [{
      type: "text",
      text: "adjust",
      text_elements: []
    }]);

    expect(rpc.calls[0]).toEqual({
      method: "turn/steer",
      params: {
        threadId: "thread-1",
        expectedTurnId: "turn-active",
        input: [{ type: "text", text: "adjust", text_elements: [] }]
      }
    });
    expect(result).toEqual({
      provider: "codex",
      provider_session_id: "thread-1",
      sessionId: "thread-1",
      turn_id: "turn-active"
    });
  });

test("interrupts an active turn through the Codex RPC contract", async () => {
    const rpc = new FakeRpc({ "turn/interrupt": {} });

    await expect(new CodexAdapter(rpc).interruptTurn("thread-1", "turn-1")).resolves.toEqual({
      ok: true,
      provider_session_id: "thread-1",
      turn_id: "turn-1"
    });

    expect(rpc.calls[0]).toEqual({
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" }
    });
  });

test("resolves approval requests through the Codex RPC contract", async () => {
    const rpc = new FakeRpc({ "approval/resolve": {} });

    await expect(new CodexAdapter(rpc).resolveApproval("approval-1", {
      decision: "approve_session", scope: "session"
    })).resolves.toEqual({ ok: true });

    expect(rpc.calls[0]).toEqual({
      method: "approval/resolve",
      params: { requestId: "approval-1", decision: "approve", scope: "turn" }
    });
  });

test("resolves pending transport approval callbacks without a separate RPC request", async () => {
    const rpc = new FakeRpc({});
    rpc.resolveApprovalRequest = async (requestID, decision) => {
      rpc.approvalResolutions.push({ requestID, decision });
    };

    await expect(new CodexAdapter(rpc).resolveApproval("approval-1", {
      decision: "approve", scope: "turn"
    })).resolves.toEqual({ ok: true });

    expect(rpc.calls).toEqual([]);
    expect(rpc.approvalResolutions).toEqual([{
      requestID: "approval-1",
      decision: { decision: "approve", scope: "turn" }
    }]);
  });

test("wraps thread lifecycle failures in diagnostic typed errors with redaction", async () => {
    const secret = "fixture-secret-token";
    const rpc = new FakeRpc({ "thread/resume": new Error(`codex rpc -32603: TOKEN=${secret}`) });

    await expect(new CodexAdapter(rpc).resumeThread("thread-1")).rejects.toThrow(CodexThreadLifecycleError);

    try {
      await new CodexAdapter(rpc).resumeThread("thread-1");
      throw new Error("expected lifecycle error");
    } catch (error) {
      expect(error).toBeInstanceOf(CodexThreadLifecycleError);
      const detail = (error as CodexThreadLifecycleError).detail;
      expect(detail).toEqual({
        provider: "codex",
        method: "thread/resume",
        code: "-32603",
        message: "codex rpc -32603: TOKEN=[redacted]"
      });
      expect(String(error)).not.toContain(secret);
    }
  });

test("surfaces RPC errors without leaking extra fields", async () => {
    const rpc = new FakeRpc({ "model/list": new Error("codex rpc -32603: boom") });
    await expect(new CodexAdapter(rpc).listModels()).rejects.toThrow("codex rpc -32603: boom");
  });
}
