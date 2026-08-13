import { asProviderId, type ExecutorProvider } from "../types.ts";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import type { ExecutorProviderManifest, ProviderCapabilities } from "../core/manifest.ts";
import type { ProviderFactory, RegisteredProvider } from "../core/registry.ts";
import { QoderExecutorProvider, type QoderExecutorProviderOptions } from "./provider.ts";
import { probeQoderRuntime, type QoderRuntimeProbe } from "./runtime.ts";
import { QODER_EXECUTION_POLICY_CAPABILITIES, qoderExecutionPolicyAdapter } from "./executionPolicy.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * P11：Qoder ProviderFactory（G11 gate 已通过）。
 * SDK 1.0.20 / CLI 1.1.18；capability 只声明实际实现。
 */

const QODER_CAPABILITIES: ProviderCapabilities = {
  issueExecution: true,
  sessions: { create: true, resume: true, list: true, read: true, fork: false, steerWhileRunning: false, export: false },
  control: { interrupt: true, approvals: "host-callback" },
  models: { list: true, switchDuringSession: false },
  usage: { tokens: "attempt" }
};

export function qoderManifest(): ExecutorProviderManifest {
  return {
    id: asProviderId("qoder"),
    displayName: "Qoder",
    supportLevel: "preview",
    transports: ["sdk"],
    capabilities: QODER_CAPABILITIES,
    executionPolicy: QODER_EXECUTION_POLICY_CAPABILITIES,
    processObservability: "lease",
    sessionPresentation: { viewContract: "xw.provider-session.v1" },
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
      const runtimeConfig = withPinnedQoderCli(config as ProviderRuntimeConfig);
      const result = runtimeProbe?.(runtimeConfig) ?? probeQoderRuntime(runtimeConfig);
      return {
        installed: result.installed,
        ready: result.ready,
        ...(result.reason ? { reason: result.reason } : {}),
        runtimeStatus: result.status
      };
    },
    create: (config) => {
      const runtimeConfig = withPinnedQoderCli(config as ProviderRuntimeConfig);
      const readiness = runtimeProbe?.(runtimeConfig) ?? probeQoderRuntime(runtimeConfig);
      const instance = new QoderExecutorProvider(runtimeConfig, { ...providerOptions, readiness }) as ExecutorProvider;
      return Object.assign(instance, { manifest, policyAdapter: qoderExecutionPolicyAdapter }) as RegisteredProvider;
    }
  };
}

export function withPinnedQoderCli(config: ProviderRuntimeConfig): ProviderRuntimeConfig {
  const configured = typeof config.command === "string" ? config.command.trim() : "";
  if (configured !== "" && configured !== "qodercli") return config;
  const adjacent = `${process.execPath}.qodercli.mjs`;
  if (existsSync(adjacent)) return { ...config, command: adjacent };
  const bundled = join(import.meta.dir, "../../../node_modules/@qoder-ai/qodercli/bundle/qodercli.js");
  return existsSync(bundled) ? { ...config, command: bundled } : config;
}
