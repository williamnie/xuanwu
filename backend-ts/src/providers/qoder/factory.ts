import { asProviderId, type ExecutorProvider } from "../types.ts";
import type { ExecutorProviderManifest, ProviderCapabilities } from "../core/manifest.ts";
import type { ProviderFactory, RegisteredProvider } from "../core/registry.ts";
import { QoderExecutorProvider, type QoderExecutorProviderOptions } from "./provider.ts";
import { createQoderSdkFacade } from "./sdkFacade.ts";

/**
 * P11：Qoder ProviderFactory（G11 gate 已通过）。
 * SDK 1.0.17 / CLI 1.1.14；capability 只声明实际实现（create/resume/interrupt；无 list/read/model list facade）。
 */

const QODER_CAPABILITIES: ProviderCapabilities = {
  issueExecution: true,
  sessions: { create: true, resume: true, list: false, read: false, fork: false, steerWhileRunning: false, export: false },
  control: { interrupt: true, approvals: "none" },
  models: { list: false, switchDuringSession: false },
  usage: { tokens: "attempt", money: "provider-reported" }
};

export function qoderManifest(): ExecutorProviderManifest {
  return {
    id: asProviderId("qoder"),
    displayName: "Qoder",
    supportLevel: "preview",
    transports: ["sdk"],
    capabilities: QODER_CAPABILITIES,
    processObservability: "lease",
    executionSettings: {
      settings: [
        { kind: "string", key: "model", label: "Model" },
        { kind: "enum", key: "effort", label: "Effort", options: [
          { value: "low", label: "低" },
          { value: "medium", label: "中" },
          { value: "high", label: "高" },
          { value: "max", label: "Max" }
        ] }
      ]
    }
  };
}

export type QoderFactoryOptions = QoderExecutorProviderOptions;

export function qoderFactory(options: QoderFactoryOptions = {}): ProviderFactory {
  const manifest = qoderManifest();
  return {
    manifest,
    parseConfig: (raw: unknown) => (raw ?? {}) as Record<string, unknown>,
    autoDetect: () => {
      // 惰性探测：SDK 可加载且 qodercli 可达才 ready
      try {
        const facade = createQoderSdkFacade();
        return { installed: true, ready: facade.available };
      } catch {
        return { installed: true, ready: false, reason: "qoder SDK unavailable" };
      }
    },
    create: () => {
      const instance = new QoderExecutorProvider(options) as ExecutorProvider;
      return Object.assign(instance, { manifest }) as RegisteredProvider;
    }
  };
}
