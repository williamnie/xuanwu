import { describe, expect, test } from "bun:test";
import { asProviderId, type ProviderEvent } from "../types.ts";
import { PiRpcTransport, piRpcChildEnv, type PiRpcCommand, type PiRpcEvent } from "./rpcTransport.ts";
import { PiExecutorProvider } from "./provider.ts";
import { piFactory, piManifest } from "./factory.ts";
import { createProviderRegistry } from "../core/registry.ts";
import { PI_EXECUTION_POLICY_CAPABILITIES, piExecutionPolicyAdapter } from "./executionPolicy.ts";
import { resolveExecutionPolicy } from "../core/policyResolution.ts";
import type { ExecutionPolicyRequest } from "../core/policyContracts.ts";
import xuanwuPolicyExtension from "./xuanwuPolicyExtension.ts";

import { FakePiTransport, piPolicy, waitFor } from "./providerTestFixtures.ts";

export function registerReadSessionPiSessionTranscript() {
test("readSession 从 Pi 权威 session 文件投影 transcript", async () => {
    const provider = new PiExecutorProvider({
      sessionFunctions: {
        async resolve(id) { return id === "pi-history" ? "/tmp/pi-history.jsonl" : undefined; },
        read(path) {
          expect(path).toBe("/tmp/pi-history.jsonl");
          return {
            id: "pi-history",
            cwd: "/tmp/demo",
            name: "Pi history",
            createdAt: 10,
            updatedAt: 20,
            entries: [{
              type: "message",
              id: "user-1",
              parentId: null,
              timestamp: "2026-08-05T00:00:00Z",
              message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }
            }]
          };
        }
      }
    });

    expect(await provider.readSession("pi-history")).toMatchObject({
      id: "pi-coding-agent:pi-history",
      cwd: "/tmp/demo",
      status: "idle",
      turns: [{ id: "user-1", items: [{ type: "userMessage", content: [{ type: "input_text", text: "hello" }] }] }]
    });
  });

test("readSession 对解析到其他 identity 的历史文件 fail closed", async () => {
    const provider = new PiExecutorProvider({
      sessionFunctions: {
        async resolve() { return "/tmp/mismatched.jsonl"; },
        read() {
          return {
            id: "different-session",
            cwd: "/tmp/demo",
            name: "",
            createdAt: 10,
            updatedAt: 20,
            entries: []
          };
        }
      }
    });

    await expect(provider.readSession("requested-session")).rejects.toThrow(
      "Pi session requested-session resolved to mismatched history different-session"
    );
  });

test("run 发送 prompt，agent_settled 收敛 terminal，返回 session", async () => {
    const transport = new FakePiTransport();
    const provider = new PiExecutorProvider({ transport });
    const events: ProviderEvent[] = [];
    const runPromise = provider.run({ issueId: 1, projectId: "p", cwd: "/tmp", prompt: "do it", sandbox: "danger-full-access", onEvent: (event) => events.push(event) });
    setTimeout(() => transport.pushEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } }), 5);
    setTimeout(() => transport.pushEvent({ type: "agent_settled" }), 10);
    const result = await runPromise;
    expect(transport.sent.some((c) => c.type === "prompt")).toBe(true);
    expect(result.session?.sessionId).toBe("pi-session-1");
    expect(result.runId).toMatch(/^pi-rpc-/);
    expect(transport.sent).toContainEqual(expect.objectContaining({ id: result.runId, message: "do it", type: "prompt" }));
    expect(events).toContainEqual(expect.objectContaining({ provider: "pi-coding-agent", text: "done", type: "provider.message" }));
    expect(events[0]).toMatchObject({
      provider: "pi-coding-agent",
      session: { provider: "pi-coding-agent", sessionId: "pi-session-1" },
      status: "running",
      type: "provider.session_started"
    });
    expect(events.at(-1)).toMatchObject({
      provider: "pi-coding-agent",
      runEvent: { contract: "xw.run-event.v1", kind: "completed", outcome: "succeeded", terminal: true },
      type: "provider.completed"
    });
  });

test("model error 在 agent_settled 时收敛为 failed terminal", async () => {
    const transport = new FakePiTransport();
    const provider = new PiExecutorProvider({ transport });
    const events: ProviderEvent[] = [];
    const runPromise = provider.run({ issueId: 3, projectId: "p", cwd: "/tmp", prompt: "fail", sandbox: "danger-full-access", onEvent: (event) => events.push(event) });
    setTimeout(() => transport.pushEvent({
      type: "message_update",
      assistantMessageEvent: { type: "error", reason: "supplier quota exceeded" }
    }), 5);
    setTimeout(() => transport.pushEvent({ type: "agent_settled" }), 10);

    await expect(runPromise).rejects.toThrow("supplier quota exceeded");
    expect(events.at(-1)).toMatchObject({
      error: "supplier quota exceeded",
      provider: "pi-coding-agent",
      runEvent: { contract: "xw.run-event.v1", kind: "error", outcome: "failed", terminal: true },
      type: "provider.error"
    });
  });

test("recover 用稳定 session UUID 启动后发送续接 prompt", async () => {
    const transport = new FakePiTransport();
    const provider = new PiExecutorProvider({ transport });
    const runPromise = provider.recover({
      issueId: 2,
      projectId: "p",
      cwd: "/tmp",
      prompt: "continue",
      sandbox: "danger-full-access",
      session: { provider: "pi-coding-agent", sessionId: "parent-9" },
      onEvent: () => {}
    });
    setTimeout(() => transport.pushEvent({ type: "agent_settled" }), 10);
    const result = await runPromise;
    expect(transport.sessionRefs).toEqual(["parent-9"]);
    expect(transport.sent).toContainEqual(expect.objectContaining({ id: result.runId, type: "prompt", message: "continue" }));
  });

test("interrupt 发送 abort", async () => {
    const transport = new FakePiTransport();
    const provider = new PiExecutorProvider({ transport });
    await transport.start();
    await provider.interrupt({ session: { provider: "pi-coding-agent", sessionId: "s" } });
    expect(transport.sent.some((c) => c.type === "abort")).toBe(true);
    expect(transport.running).toBe(false);
  });

test("host interrupt 不会被重新报告成 Provider failure", async () => {
    const transport = new FakePiTransport();
    const provider = new PiExecutorProvider({ transport });
    const events: ProviderEvent[] = [];
    const runPromise = provider.run({
      issueId: 10,
      projectId: "p",
      cwd: "/tmp",
      prompt: "wait",
      sandbox: "danger-full-access",
      onEvent: (event) => events.push(event)
    });
    await Bun.sleep(0);

    await provider.interrupt({
      reason: "issue_cancel",
      session: { provider: "pi-coding-agent", sessionId: "pi-session-1" }
    });
    transport.pushEvent({ type: "exit", signal: "SIGTERM" });

    await expect(runPromise).rejects.toThrow("interrupted by host");
    expect(events.some((event) => event.runEvent?.outcome === "failed")).toBe(false);
  });

test("abort RPC 无响应时仍会在 Host 门限内停止 transport", async () => {
    const transport = new FakePiTransport();
    transport.hangAbort = true;
    const provider = new PiExecutorProvider({ transport });
    await transport.start();
    const startedAt = Date.now();

    await provider.interrupt({
      reason: "issue_cancel",
      session: { provider: "pi-coding-agent", sessionId: "pi-session-1" }
    });

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(transport.running).toBe(false);
  });

test("活动事件续期空闲超时，长任务不会被总时长误杀", async () => {
    const transport = new FakePiTransport();
    const provider = new PiExecutorProvider({ timeoutMs: 25, transport });
    const runPromise = provider.run({
      issueId: 7,
      projectId: "p",
      cwd: "/tmp",
      prompt: "keep working",
      sandbox: "danger-full-access"
    });
    setTimeout(() => transport.pushEvent({ type: "agent_start" }), 15);
    setTimeout(() => transport.pushEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "progress" } }), 30);
    setTimeout(() => transport.pushEvent({ type: "agent_settled" }), 45);

    await expect(runPromise).resolves.toMatchObject({
      session: { provider: "pi-coding-agent", sessionId: "pi-session-1" }
    });
  });
}
