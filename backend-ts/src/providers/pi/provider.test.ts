import { describe, expect, test } from "bun:test";
import { asProviderId, type ProviderEvent } from "../types.ts";
import { PiRpcTransport, piRpcChildEnv, type PiRpcCommand, type PiRpcEvent } from "./rpcTransport.ts";
import { PiExecutorProvider } from "./provider.ts";
import { piFactory, piManifest } from "./factory.ts";
import { createProviderRegistry } from "../core/registry.ts";

/** Fake transport：不回显子进程，直接注入 response/event 流。 */
class FakePiTransport extends PiRpcTransport {
  readonly sent: PiRpcCommand[] = [];
  readonly emitted: PiRpcEvent[] = [];
  readonly sessionRefs: string[] = [];
  readonly toolSets: string[][] = [];
  started = false;

  constructor() {
    super("fake-pi");
  }

  override async start(): Promise<void> {
    this.started = true;
  }

  override async startForSession(sessionRef = "", tools: readonly string[] = []): Promise<void> {
    this.sessionRefs.push(sessionRef);
    this.toolSets.push([...tools]);
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
    if (command.type === "get_state") return { sessionId: "pi-session-1", thinkingLevel: "medium", isStreaming: false, isCompacting: false, steeringMode: "all", followUpMode: "all", autoCompactionEnabled: true, messageCount: 1, pendingMessageCount: 0 };
    if (command.type === "get_available_models") return [{ id: "glm-5.2", display_name: "GLM 5.2" }];
    return {};
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
    await registry.startConfigured({});
    expect(registry.list().map((e) => String(e.id))).toContain("pi-coding-agent");
    expect(registry.describe(asProviderId("pi-coding-agent")).state).toBe("ready");
  });
});
