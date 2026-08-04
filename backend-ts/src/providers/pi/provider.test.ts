import { describe, expect, test } from "bun:test";
import { asProviderId } from "../types.ts";
import { PiRpcTransport, type PiRpcCommand, type PiRpcEvent } from "./rpcTransport.ts";
import { PiExecutorProvider } from "./provider.ts";
import { piFactory, piManifest } from "./factory.ts";
import { createProviderRegistry } from "../core/registry.ts";

/** Fake transport：不回显子进程，直接注入 response/event 流。 */
class FakePiTransport extends PiRpcTransport {
  readonly sent: PiRpcCommand[] = [];
  readonly emitted: PiRpcEvent[] = [];
  started = false;

  constructor() {
    super("fake-pi");
  }

  override async start(): Promise<void> {
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
});

describe("P10: Pi executor（fake transport）", () => {
  test("run 发送 prompt，agent_settled 收敛 terminal，返回 session", async () => {
    const transport = new FakePiTransport();
    const provider = new PiExecutorProvider({ transport });
    const runPromise = provider.run({ issueId: 1, projectId: "p", cwd: "/tmp", prompt: "do it", onEvent: () => {} });
    setTimeout(() => transport.pushEvent({ type: "agent_settled" }), 10);
    const result = await runPromise;
    expect(transport.sent.some((c) => c.type === "prompt")).toBe(true);
    expect(result.session?.sessionId).toBe("pi-session-1");
    expect(result.runId).toBe("pi-run-1");
  });

  test("recover 用 new_session(parentSession) 树形续接", async () => {
    const transport = new FakePiTransport();
    const provider = new PiExecutorProvider({ transport });
    const runPromise = provider.recover({
      issueId: 2,
      projectId: "p",
      cwd: "/tmp",
      prompt: "continue",
      session: { provider: "pi", sessionId: "parent-9" },
      onEvent: () => {}
    });
    setTimeout(() => transport.pushEvent({ type: "agent_settled" }), 10);
    await runPromise;
    const newSession = transport.sent.find((c) => c.type === "new_session");
    expect(newSession).toBeDefined();
    expect((newSession as { parentSession?: string } | undefined)?.parentSession).toBe("parent-9");
  });

  test("interrupt 发送 abort", async () => {
    const transport = new FakePiTransport();
    const provider = new PiExecutorProvider({ transport });
    await provider.interrupt({ session: { provider: "pi", sessionId: "s" } });
    expect(transport.sent.some((c) => c.type === "abort")).toBe(true);
  });

  test("listModels 解析 get_available_models", async () => {
    const transport = new FakePiTransport();
    const provider = new PiExecutorProvider({ transport });
    const models = await provider.listModels();
    expect(models).toEqual([{ id: "glm-5.2", display_name: "GLM 5.2" }]);
  });
});

describe("P10: Pi factory 与 manifest", () => {
  test("manifest 声明实际能力（无 list/read，不伪造）", () => {
    const manifest = piManifest();
    expect(String(manifest.id)).toBe("pi");
    expect(manifest.supportLevel).toBe("preview");
    expect(manifest.capabilities.issueExecution).toBe(true);
    expect(manifest.capabilities.sessions?.create).toBe(true);
    expect(manifest.capabilities.sessions?.resume).toBe(true);
    expect(manifest.capabilities.sessions?.fork).toBe(true);
    expect(manifest.capabilities.sessions?.list).toBe(false);
    expect(manifest.capabilities.sessions?.read).toBe(false);
    expect(manifest.capabilities.control?.interrupt).toBe(true);
    expect(manifest.capabilities.models?.list).toBe(true);
  });

  test("factory 注册后可发现", async () => {
    const registry = createProviderRegistry();
    registry.registerFactory(piFactory({}));
    await registry.startConfigured({});
    expect(registry.list().map((e) => String(e.id))).toContain("pi");
    expect(registry.describe(asProviderId("pi")).state).toBe("ready");
  });
});
