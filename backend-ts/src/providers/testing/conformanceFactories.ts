import { asProviderId, type ExecutorProvider } from "../types.ts";
import type { ExecutorProviderManifest, ProviderCapabilities } from "../core/manifest.ts";
import type { ProviderFactory, RegisteredProvider } from "../core/registry.ts";
import { ExecutionOnlyProvider, FullSessionProvider, ResumableSessionProvider } from "./conformanceFixtures.ts";

/**
 * P2：把 P0 三类 conformance fixture 包装为 ProviderFactory（设计 §3.1 编译期内置 factory 示例）。
 * 生产内置 factory 集合（BUILTIN_FACTORIES）由编译期 import map 提供；
 * 这里为测试/P2 conformance 复用，P7/P8 迁移时替换为真实 adapter factory。
 */

const EXECUTION_ONLY_CAPS: ProviderCapabilities = { issueExecution: true };

const RESUMABLE_CAPS: ProviderCapabilities = {
  issueExecution: true,
  sessions: { resume: true }
};

const FULL_SESSION_CAPS: ProviderCapabilities = {
  issueExecution: true,
  sessions: { create: true, list: true, read: true, resume: true },
  control: { interrupt: true, approvals: "host-callback" },
  models: { list: true }
};

function wrap(fixture: ExecutorProvider, capabilities: ProviderCapabilities, displayName: string): ProviderFactory {
  const manifest: ExecutorProviderManifest = {
    id: asProviderId(fixture.id),
    displayName,
    supportLevel: "tested",
    transports: ["stdio-json"],
    capabilities
  };
  return {
    manifest,
    parseConfig: (raw: unknown) => ({ ...(raw as Record<string, unknown>) }),
    autoDetect: () => ({ installed: true, ready: true }),
    // 保留 fixture 类原型方法（spread 会丢失），仅附加 manifest
    create: () => Object.assign(fixture, { manifest }) as RegisteredProvider
  };
}

export function executionOnlyFactory(): ProviderFactory {
  return wrap(new ExecutionOnlyProvider(), EXECUTION_ONLY_CAPS, "Fake Execution-Only Provider");
}

export function resumableFactory(): ProviderFactory {
  return wrap(new ResumableSessionProvider(), RESUMABLE_CAPS, "Fake Resumable Provider");
}

export function fullSessionFactory(): ProviderFactory {
  return wrap(new FullSessionProvider(), FULL_SESSION_CAPS, "Fake Full-Session Provider");
}

/** P2：编译期内置 factory 集合（生产只允许此集合，P7/P8 前为 conformance fixture）。 */
export const BUILTIN_FACTORIES: readonly ProviderFactory[] = [
  executionOnlyFactory(),
  resumableFactory(),
  fullSessionFactory()
];
