import type { ProviderRuntimeConfig } from "../../config/env.ts";
import { asProviderId, type ExecutorProvider, type ProviderEvent } from "../types.ts";
import type { ExecutorProviderManifest, ProviderCapabilities } from "../core/manifest.ts";
import type { ProviderFactory, ProviderRuntimeConfig as RegistryProviderConfig, RegisteredProvider } from "../core/registry.ts";
import { createClaudeExecutorProvider } from "./provider.ts";

/**
 * P8：Claude ProviderFactory——SDK 与 CLI transport 共享 manifest/session projection。
 * - capability 只声明实际实现（SDK/CLI 均无 approvals/model_list）；
 * - 没有真实账号 acceptance 前 supportLevel 保持 preview；
 * - Claude-native history parser（sessionHistory.ts）留在 Claude module；
 * - 本地 CLI 登录、设置和 Session 复用由 delegate（cliProvider）保持。
 */

const CLAUDE_CAPABILITIES: ProviderCapabilities = {
  issueExecution: true,
  sessions: { create: true, list: true, read: true, resume: true, fork: false, steerWhileRunning: false, export: false },
  control: { interrupt: true, approvals: "none" },
  models: { list: false, switchDuringSession: false },
  usage: { tokens: "attempt", money: "provider-reported" }
};

export function claudeManifest(): ExecutorProviderManifest {
  return {
    id: asProviderId("claude"),
    displayName: "Claude Agent SDK",
    supportLevel: "preview",
    transports: ["sdk", "stdio-json"],
    capabilities: CLAUDE_CAPABILITIES,
    processObservability: "lease",
    executionSettings: {
      settings: [
        { kind: "string", key: "model", label: "Model" },
        { kind: "enum", key: "mode", label: "Transport", options: [
          { value: "sdk", label: "SDK" },
          { value: "cli-fallback", label: "CLI fallback" }
        ] },
        { kind: "enum", key: "auth_mode", label: "Auth source", options: [
          { value: "local-cli", label: "本地 CLI 登录" },
          { value: "runner-env", label: "Runner env" }
        ] }
      ]
    }
  };
}

export type ClaudeFactoryOptions = {
  eventSink?: (event: ProviderEvent) => void;
};

export function claudeFactory(options: ClaudeFactoryOptions = {}): ProviderFactory {
  const manifest = claudeManifest();
  return {
    manifest,
    parseConfig: (raw: unknown) => (raw ?? {}) as RegistryProviderConfig,
    autoDetect: () => ({ installed: true, ready: true }),
    create: (config: RegistryProviderConfig) => {
      const instance = createClaudeExecutorProvider(config as ProviderRuntimeConfig, options.eventSink) as ExecutorProvider;
      return Object.assign(instance, { manifest }) as RegisteredProvider;
    }
  };
}
