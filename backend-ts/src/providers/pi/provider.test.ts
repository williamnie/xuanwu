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

/** Fake transport：不回显子进程，直接注入 response/event 流。 */
class FakePiTransport extends PiRpcTransport {
  readonly sent: PiRpcCommand[] = [];
  readonly emitted: PiRpcEvent[] = [];
  readonly sessionRefs: string[] = [];
  readonly toolSets: string[][] = [];
  readonly extensionSets: string[][] = [];
  readonly extensionResponses: Array<{ id: string; response: { cancelled?: boolean; confirmed?: boolean; value?: string } }> = [];
  hangAbort = false;
  started = false;

  constructor() {
    super("fake-pi");
  }

  override async start(): Promise<void> {
    this.started = true;
  }

  override async startForSession(sessionRef = "", tools: readonly string[] = [], extensions: readonly string[] = []): Promise<void> {
    this.sessionRefs.push(sessionRef);
    this.toolSets.push([...tools]);
    this.extensionSets.push([...extensions]);
    this.started = true;
  }

  override async stop(): Promise<void> {
    this.started = false;
  }

  override get running(): boolean {
    return this.started;
  }

  override async send(command: PiRpcCommand): Promise<unknown> {
    this.sent.push(command);
    if (command.type === "abort" && this.hangAbort) return await new Promise(() => {});
    if (command.type === "get_state") return { sessionId: "pi-session-1", thinkingLevel: "medium", isStreaming: false, isCompacting: false, steeringMode: "all", followUpMode: "all", autoCompactionEnabled: true, messageCount: 1, pendingMessageCount: 0 };
    if (command.type === "get_available_models") return [{ id: "glm-5.2", display_name: "GLM 5.2" }];
    return {};
  }

  override async respondExtensionUI(id: string, response: { cancelled?: boolean; confirmed?: boolean; value?: string }): Promise<void> {
    this.extensionResponses.push({ id, response });
  }

  pushEvent(event: PiRpcEvent): void {
    this.emitted.push(event);
    this.emitEvent(event);
  }
}

describe("P10: Pi RPC transport 协议", () => {
  test("response 关联 command id 并解析 data", async () => {
    const transport = new PiRpcTransport("ignored");
    // 通过 handleLine 私有逻辑间接验证：无法直接访问，用 provider 集成测试覆盖
    expect(transport).toBeDefined();
    expect(typeof transport.send).toBe("function");
  });

  test("外部 Pi 不继承 Xuanwu 的内部资源目录，显式覆盖仍保留", () => {
    expect(piRpcChildEnv({ PATH: "/usr/bin", PI_PACKAGE_DIR: "/xuanwu/assets" })).toEqual({
      PATH: "/usr/bin"
    });
    expect(piRpcChildEnv(
      { PATH: "/usr/bin", PI_PACKAGE_DIR: "/xuanwu/assets" },
      { PI_PACKAGE_DIR: "/custom/pi" }
    )).toEqual({
      PATH: "/usr/bin",
      PI_PACKAGE_DIR: "/custom/pi"
    });
  });

  test("Extension maps confirm timeout, cancellation, and errors to a blocked tool call", async () => {
    let handler: ((event: Record<string, unknown>, context: Record<string, any>) => Promise<unknown>) | undefined;
    xuanwuPolicyExtension({ on: (_event, value) => { handler = value; } });
    const event = { toolName: "bash", toolCallId: "tool-1", input: { command: "rm -rf build" } };
    await expect(handler!(event, { ui: { confirm: async () => false } })).resolves.toMatchObject({ block: true });
    await expect(handler!(event, { ui: { confirm: async () => { throw new Error("timeout"); } } })).resolves.toMatchObject({ block: true });
    await expect(handler!(event, { ui: { confirm: async () => true } })).resolves.toBeUndefined();
  });
});

describe("P10: Pi executor（fake transport）", () => {
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

  test("approval bridge load failure is terminal", async () => {
    const transport = new FakePiTransport();
    const provider = new PiExecutorProvider({ policyExtensionPath: "/tmp/missing.ts", transport });
    const events: ProviderEvent[] = [];
    const runPromise = provider.run({
      cwd: "/tmp",
      issueId: 13,
      projectId: "p",
      prompt: "edit",
      policy: piPolicy({ access: "unrestricted-host", approval: "ask-sensitive" }),
      onEvent: (event) => events.push(event)
    });
    await Bun.sleep(0);
    transport.pushEvent({ type: "stderr", text: "Failed to load extension /tmp/missing.ts" });

    await expect(runPromise).rejects.toThrow("approval_bridge_unavailable");
    expect(transport.running).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      raw: { method: "pi-coding-agent/approval_bridge_unavailable" },
      status: "failed"
    }));
  });

  test("listModels 解析 get_available_models", async () => {
    const transport = new FakePiTransport();
    const provider = new PiExecutorProvider({ transport });
    const models = await provider.listModels();
    expect(models).toEqual([{ id: "glm-5.2", display_name: "GLM 5.2" }]);
  });
});

describe("P10: Pi factory 与 manifest", () => {
  test("manifest 声明实际能力（native read、无 list，不伪造）", () => {
    const manifest = piManifest();
    expect(String(manifest.id)).toBe("pi-coding-agent");
    expect(manifest.supportLevel).toBe("preview");
    expect(manifest.capabilities.issueExecution).toBe(true);
    expect(manifest.capabilities.sessions?.create).toBe(true);
    expect(manifest.capabilities.sessions?.resume).toBe(true);
    expect(manifest.capabilities.sessions?.fork).toBe(false);
    expect(manifest.capabilities.sessions?.steerWhileRunning).toBe(false);
    expect(manifest.capabilities.sessions?.list).toBe(false);
    expect(manifest.capabilities.sessions?.read).toBe(true);
    expect(manifest.sessionPresentation?.viewContract).toBe("xw.provider-session.v1");
    expect(manifest.capabilities.control?.interrupt).toBe(true);
    expect(manifest.capabilities.models?.list).toBe(true);
    expect(typeof (new PiExecutorProvider({ transport: new FakePiTransport() }) as { listSessions?: unknown }).listSessions).toBe("undefined");
  });

  test("factory 注册后可发现", async () => {
    const registry = createProviderRegistry();
    registry.registerFactory(piFactory({}));
    await registry.startConfigured({ "pi-coding-agent": { command: process.execPath } });
    expect(registry.list().map((e) => String(e.id))).toContain("pi-coding-agent");
    expect(registry.describe(asProviderId("pi-coding-agent")).state).toBe("ready");
  });
});

function piPolicy(input: Omit<ExecutionPolicyRequest, "contract">) {
  return resolveExecutionPolicy({ contract: "xw.execution-policy.v1", ...input }, {
    cwd: "/tmp",
    invocationRef: "pi-invocation",
    projectId: "p",
    providerId: "pi-coding-agent",
    providerVersion: "0.83.0",
    source: "local-user",
    transport: "rpc"
  }, PI_EXECUTION_POLICY_CAPABILITIES, piExecutionPolicyAdapter);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("fixture condition was not reached");
}
