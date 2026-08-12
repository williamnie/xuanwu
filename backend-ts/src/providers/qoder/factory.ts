import { asProviderId, type ExecutorProvider } from "../types.ts";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import type { ExecutorProviderManifest, ProviderCapabilities } from "../core/manifest.ts";
import type { ProviderFactory, RegisteredProvider } from "../core/registry.ts";
import { QoderExecutorProvider, type QoderExecutorProviderOptions } from "./provider.ts";
import { probeQoderRuntime, type QoderRuntimeProbe } from "./runtime.ts";

/**
 * P11：Qoder ProviderFactory（G11 gate 已通过）。
 * SDK 1.0.20 / CLI 1.1.18；capability 只声明实际实现（create/resume/interrupt；无 list/read/model list facade）。
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
        { kind: "string", key: "command", label: "Qoder CLI executable" },
        { kind: "string", key: "configDir", label: "Config directory" },
        { kind: "enum", key: "authMode", label: "Auth source", options: [
          { value: "pat-env", label: "PAT environment" },
          { value: "pat-secret-ref", label: "PAT secret ref" },
          { value: "service-account-secret-ref", label: "Service Account secret ref" },
          { value: "local-cli", label: "Local CLI login" }
        ] },
        { kind: "secret-ref", key: "credentialRef", label: "Credential secret ref" }
      ]
    }
  };
}

export type QoderFactoryOptions = QoderExecutorProviderOptions & {
  runtimeProbe?: (config: ProviderRuntimeConfig) => QoderRuntimeProbe;
};

export function qoderFactory(options: QoderFactoryOptions = {}): ProviderFactory {
  const manifest = qoderManifest();
  const { runtimeProbe, ...providerOptions } = options;
  return {
    manifest,
    parseConfig: (raw: unknown) => (raw ?? {}) as Record<string, unknown>,
    autoDetect: (config) => {
      const result = runtimeProbe?.(config as ProviderRuntimeConfig) ?? probeQoderRuntime(config as ProviderRuntimeConfig);
      return {
        installed: result.installed,
        ready: result.ready,
        ...(result.reason ? { reason: result.reason } : {}),
        runtimeStatus: result.status
      };
    },
    create: (config) => {
      const readiness = runtimeProbe?.(config as ProviderRuntimeConfig) ?? probeQoderRuntime(config as ProviderRuntimeConfig);
      const instance = new QoderExecutorProvider(config as ProviderRuntimeConfig, { ...providerOptions, readiness }) as ExecutorProvider;
      return Object.assign(instance, { manifest }) as RegisteredProvider;
    }
  };
}
