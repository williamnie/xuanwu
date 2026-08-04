import { asProviderId, type ExecutorProvider } from "../types.ts";
import type { ExecutorProviderManifest, ProviderCapabilities } from "../core/manifest.ts";
import type { ProviderFactory, RegisteredProvider } from "../core/registry.ts";
import { PiExecutorProvider, type PiExecutorProviderOptions } from "./provider.ts";

/**
 * P10：Pi Coding Agent ProviderFactory（G10 gate 已通过）。
 * RPC transport（pi 0.83.0，JSON lines stdio）；session 语义为 tree session（fork/parentSession）。
 * capability-limited：list/read session 未实现（Pi RPC 无 list 命令），不伪造能力。
 */

const PI_CAPABILITIES: ProviderCapabilities = {
  issueExecution: true,
  sessions: { create: true, resume: true, fork: true, list: false, read: false, steerWhileRunning: true, export: false },
  // RPC 无法注入 approval 决定（host callback 属于 Pi 内部），不伪造能力 → none
  control: { interrupt: true, approvals: "none" },
  models: { list: true, switchDuringSession: true },
  usage: { tokens: "attempt", money: "provider-reported" }
};

export function piManifest(): ExecutorProviderManifest {
  return {
    id: asProviderId("pi"),
    displayName: "Pi Coding Agent",
    supportLevel: "preview",
    transports: ["rpc"],
    capabilities: PI_CAPABILITIES,
    processObservability: "lease",
    executionSettings: {
      settings: [
        { kind: "string", key: "model", label: "Model" },
        { kind: "enum", key: "thinking", label: "Thinking level", options: [
          { value: "off", label: "Off" },
          { value: "minimal", label: "Minimal" },
          { value: "low", label: "低" },
          { value: "medium", label: "中" },
          { value: "high", label: "高" },
          { value: "xhigh", label: "超高" },
          { value: "max", label: "Max" }
        ] }
      ]
    }
  };
}

export type PiFactoryOptions = PiExecutorProviderOptions & { command?: string };

export function piFactory(options: PiFactoryOptions = {}): ProviderFactory {
  const manifest = piManifest();
  return {
    manifest,
    parseConfig: (raw: unknown) => (raw ?? {}) as Record<string, unknown>,
    autoDetect: () => ({ installed: true, ready: true }),
    create: () => {
      const instance = new PiExecutorProvider(options) as ExecutorProvider;
      return Object.assign(instance, { manifest }) as RegisteredProvider;
    }
  };
}
