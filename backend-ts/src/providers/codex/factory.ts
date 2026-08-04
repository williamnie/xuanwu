import type { ProviderRuntimeConfig } from "../../config/env.ts";
import { asProviderId, type ExecutorProvider } from "../types.ts";
import type { ExecutorProviderManifest, ProviderCapabilities } from "../core/manifest.ts";
import type { ProviderFactory, ProviderRuntimeConfig as RegistryProviderConfig, RegisteredProvider } from "../core/registry.ts";
import { createCodexExecutorProvider, type CodexAppEventSink } from "./provider.ts";

/**
 * P7：Codex ProviderFactory——app-server 生命周期迁入 registry facet。
 * thread/turn 映射为 session/message refs（legacyProjection 单一来源）；
 * approvals/model list/interrupt/session 全能力 manifest；
 * native "Open in Codex App" action 经 manifest sessionPresentation 提供。
 * Codex index reconciliation 与 rollout recovery 留在 Codex module（不在本 factory）。
 */

const CODEX_CAPABILITIES: ProviderCapabilities = {
  issueExecution: true,
  sessions: { create: true, list: true, read: true, resume: true, fork: false, steerWhileRunning: false, export: true },
  control: { interrupt: true, approvals: "host-callback" },
  models: { list: true, switchDuringSession: false },
  usage: { tokens: "attempt", money: "provider-reported" }
};

export function codexManifest(): ExecutorProviderManifest {
  return {
    id: asProviderId("codex"),
    displayName: "Codex",
    supportLevel: "tested",
    transports: ["rpc", "stdio-json"],
    capabilities: CODEX_CAPABILITIES,
    processObservability: "lease",
    executionSettings: {
      settings: [
        { kind: "string", key: "model", label: "Model" },
        { kind: "enum", key: "reasoning_effort", label: "Reasoning effort", options: [
          { value: "", label: "默认" },
          { value: "minimal", label: "Minimal" },
          { value: "low", label: "低" },
          { value: "medium", label: "中" },
          { value: "high", label: "高" },
          { value: "xhigh", label: "超高" }
        ] },
        { kind: "enum", key: "service_tier", label: "Service tier", options: [
          { value: "", label: "标准" },
          { value: "priority", label: "Priority" }
        ] }
      ]
    },
    sessionPresentation: {
      emptySession: false,
      nativeActions: [{ id: "open-in-codex-app", label: "Open in Codex App", kind: "open-in-app" }]
    }
  };
}

export type CodexFactoryOptions = {
  appEventSink?: CodexAppEventSink;
  ownershipFile?: string;
};

export function codexFactory(options: CodexFactoryOptions = {}): ProviderFactory {
  const manifest = codexManifest();
  return {
    manifest,
    // env.ts 已把 providers.codex 解析为 ProviderRuntimeConfig；直接透传
    parseConfig: (raw: unknown) => (raw ?? {}) as RegistryProviderConfig,
    autoDetect: () => ({ installed: true, ready: true }),
    create: (config: RegistryProviderConfig) => {
      const instance = createCodexExecutorProvider(config as ProviderRuntimeConfig, options.appEventSink, {
        ownershipFile: options.ownershipFile
      }) as ExecutorProvider;
      return Object.assign(instance, { manifest }) as RegisteredProvider;
    }
  };
}
