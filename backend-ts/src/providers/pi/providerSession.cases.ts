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

export function registerSession() {
test("空闲超时仍保留 Session 并发出可恢复终态", async () => {
    const transport = new FakePiTransport();
    const provider = new PiExecutorProvider({ timeoutMs: 10, transport });
    const events: ProviderEvent[] = [];

    await expect(provider.run({
      issueId: 8,
      projectId: "p",
      cwd: "/tmp",
      prompt: "stall",
      sandbox: "danger-full-access",
      onEvent: (event) => events.push(event)
    })).rejects.toThrow("pi rpc agent had no activity");

    expect(events.at(-1)).toMatchObject({
      error: "pi rpc agent had no activity for 10ms",
      runEvent: { kind: "error", outcome: "failed", retryable: true, terminal: true },
      session: { provider: "pi-coding-agent", sessionId: "pi-session-1" },
      type: "provider.error"
    });
    expect(transport.running).toBe(false);
  });

test("bash tool 终态投影为带 Session 的命令证据", async () => {
    const transport = new FakePiTransport();
    const provider = new PiExecutorProvider({ transport });
    const events: ProviderEvent[] = [];
    const runPromise = provider.run({
      issueId: 9,
      projectId: "p",
      cwd: "/tmp/project",
      prompt: "test",
      sandbox: "danger-full-access",
      onEvent: (event) => events.push(event)
    });
    setTimeout(() => transport.pushEvent({
      args: { command: "bun test" },
      toolCallId: "tool-1",
      toolName: "bash",
      type: "tool_execution_start"
    }), 5);
    setTimeout(() => transport.pushEvent({
      isError: false,
      result: { content: [{ type: "text", text: "1 pass" }] },
      toolCallId: "tool-1",
      toolName: "bash",
      type: "tool_execution_end"
    }), 10);
    setTimeout(() => transport.pushEvent({ type: "agent_settled" }), 15);

    await runPromise;
    expect(events).toContainEqual(expect.objectContaining({
      command: "bun test",
      raw: expect.objectContaining({ method: "item/completed" }),
      session: { provider: "pi-coding-agent", sessionId: "pi-session-1" },
      status: "completed",
      text: "1 pass",
      type: "tool"
    }));
  });

test("bash tool 保留非零退出码", async () => {
    const transport = new FakePiTransport();
    const provider = new PiExecutorProvider({ transport });
    const events: ProviderEvent[] = [];
    const runPromise = provider.run({
      issueId: 11,
      projectId: "p",
      cwd: "/tmp/project",
      prompt: "test failure",
      sandbox: "danger-full-access",
      onEvent: (event) => events.push(event)
    });
    setTimeout(() => transport.pushEvent({
      args: { command: "exit 7" },
      toolCallId: "tool-failed",
      toolName: "bash",
      type: "tool_execution_start"
    }), 5);
    setTimeout(() => transport.pushEvent({
      isError: true,
      result: { content: [{ type: "text", text: "Command exited with code 7" }] },
      toolCallId: "tool-failed",
      toolName: "bash",
      type: "tool_execution_end"
    }), 10);
    setTimeout(() => transport.pushEvent({ type: "agent_settled" }), 15);

    await runPromise;
    const command = events.find((event) => event.command === "exit 7");
    expect(command?.raw?.payload).toContain('"exitCode":7');
    expect(command?.status).toBe("failed");
  });

test("需要 host approval 的策略 fail closed", async () => {
    const transport = new FakePiTransport();
    const provider = new PiExecutorProvider({ transport });
    await expect(provider.run({
      approvalPolicy: "always",
      cwd: "/tmp",
      issueId: 4,
      projectId: "p",
      prompt: "do not start"
    })).rejects.toThrow("does not support host approval policy");
    expect(transport.started).toBe(false);
  });

test("read-only 映射为 Pi 内置只读工具，workspace-write 无法证明时 fail closed", async () => {
    const transport = new FakePiTransport();
    const provider = new PiExecutorProvider({ transport });
    const runPromise = provider.run({ cwd: "/tmp", issueId: 5, projectId: "p", prompt: "review", sandbox: "read-only" });
    setTimeout(() => transport.pushEvent({ type: "agent_settled" }), 10);
    await runPromise;
    expect(transport.toolSets).toEqual([["read", "grep", "find", "ls"]]);

    await expect(provider.run({
      cwd: "/tmp",
      issueId: 6,
      projectId: "p",
      prompt: "edit",
      sandbox: "workspace-write"
    })).rejects.toThrow("cannot enforce sandbox policy");
  });

test("approval extension bridges request and explicit host decision", async () => {
    const transport = new FakePiTransport();
    const provider = new PiExecutorProvider({ policyExtensionPath: "/tmp/xuanwu-pi-policy.ts", transport });
    const events: ProviderEvent[] = [];
    const runPromise = provider.run({
      cwd: "/tmp",
      issueId: 12,
      projectId: "p",
      prompt: "edit",
      policy: piPolicy({ access: "unrestricted-host", approval: "ask-every-side-effect" }),
      onEvent: (event) => events.push(event)
    });
    await Bun.sleep(0);
    transport.pushEvent({
      type: "extension_ui_request",
      id: "pi-ui-1",
      method: "confirm",
      title: "Xuanwu execution policy",
      message: JSON.stringify({
        contract: "xw.pi-policy-tool-call.v1",
        toolCallId: "tool-approval-1",
        toolName: "write",
        input: { path: "README.md" }
      })
    });
    await waitFor(() => events.some((event) => event.raw?.method === "approval/requested"));
    const requested = events.find((event) => event.raw?.method === "approval/requested");
    const requestId = String((requested?.payload as { id?: string })?.id ?? "");
    await provider.resolveApproval(requestId, { decision: "approve" });
    transport.pushEvent({ type: "agent_settled" });

    await expect(runPromise).resolves.toMatchObject({ session: { sessionId: "pi-session-1" } });
    expect(transport.extensionSets).toEqual([["/tmp/xuanwu-pi-policy.ts"]]);
    expect(transport.extensionResponses).toContainEqual({ id: "pi-ui-1", response: { confirmed: true } });
    expect(events).toContainEqual(expect.objectContaining({ raw: { method: "approval/resolved", payload: expect.any(Object) }, status: "approve" }));
  });

test("unattended and read-only policy invocations do not load the approval extension", async () => {
    for (const request of [
      { access: "unrestricted-host", approval: "unattended" },
      { access: "read-only", approval: "ask-every-side-effect" }
    ] as const) {
      const transport = new FakePiTransport();
      const provider = new PiExecutorProvider({ policyExtensionPath: "/tmp/xuanwu-pi-policy.ts", transport });
      const runPromise = provider.run({
        cwd: "/tmp",
        issueId: 14,
        projectId: "p",
        prompt: "policy",
        policy: piPolicy(request)
      });
      setTimeout(() => transport.pushEvent({ type: "agent_settled" }), 5);
      await runPromise;
      expect(transport.extensionSets).toEqual([[]]);
    }
  });
}
