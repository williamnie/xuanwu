import { describe, expect, test } from "bun:test";
import type { SDKMessage, SDKResultMessage, SDKSessionInfo, SDKSystemInitMessage, SessionMessage } from "@qoder-ai/qoder-agent-sdk";
import { buildConfig } from "../../config/env.ts";
import { checkManifest } from "../core/conformance.ts";
import { createProviderRegistry } from "../core/registry.ts";
import { asProviderId, isProviderInterruptedError, type ProviderEvent } from "../types.ts";
import { qoderFactory, qoderManifest } from "./factory.ts";
import { QoderExecutorProvider } from "./provider.ts";
import {
  createFakeQoderSdkFacade,
  type QoderQueryResult,
  type QoderRunOptions,
  type QoderSdkFacade
} from "./sdkFacade.ts";
import type { QoderRuntimeProbe } from "./runtime.ts";
import type { QoderSessionFunctions } from "./sessionHistory.ts";

import { qoderConfig, readyProbe, init, taskNotification, sdkResult, provider, sessionInfo, history, ConcurrentFacade } from "./providerTestFixtures.ts";

export function registerManifestCapabilitiesMatchTheImplementedProvider() {
test("manifest capabilities match the implemented provider surface", () => {
    const manifest = qoderManifest();
    const subject = provider(createFakeQoderSdkFacade([init(), sdkResult()]).facade);
    expect(() => checkManifest(manifest, subject as unknown as Record<string, unknown>)).not.toThrow();
    expect(manifest).toMatchObject({
      supportLevel: "preview",
      capabilities: {
        issueExecution: true,
        sessions: { create: true, resume: true, list: true, read: true },
        control: { interrupt: true, approvals: "host-callback" },
        models: { list: true, switchDuringSession: false },
        usage: { tokens: "attempt" }
      },
      processObservability: "lease"
    });
    expect(manifest.sessionPresentation?.viewContract).toBe("xw.provider-session.v1");
  });

test("factory registers Qoder as ready with the fake runtime", async () => {
    const registry = createProviderRegistry();
    registry.registerFactory(qoderFactory({
      facade: createFakeQoderSdkFacade([init(), sdkResult()]).facade,
      runtimeProbe: () => readyProbe
    }));
    await registry.startConfigured({});
    expect(registry.list().map((entry) => String(entry.id))).toContain("qoder");
    expect(registry.describe(asProviderId("qoder")).state).toBe("ready");
  });
}
