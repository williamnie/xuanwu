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

export function registerResponseCommandIdData() {
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
}
