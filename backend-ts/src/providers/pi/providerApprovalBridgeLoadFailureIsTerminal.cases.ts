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

export function registerApprovalBridgeLoadFailureIsTerminal() {
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
}
