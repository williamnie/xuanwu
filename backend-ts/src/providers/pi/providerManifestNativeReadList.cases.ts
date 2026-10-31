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

export function registerManifestNativeReadList() {
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
}
