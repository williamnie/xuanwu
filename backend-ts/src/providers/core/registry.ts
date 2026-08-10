import {
  asProviderId,
  type ExecutorProvider,
  type ProviderId,
  type ProviderRuntimeStatus
} from "../types.ts";
import { checkManifest } from "./conformance.ts";
import { providerRegistryError, type ProviderErrorCategory } from "./errors.ts";
import type { ExecutorProviderManifest } from "./manifest.ts";

/** P2：adapter 自己解析 provider-specific config；生产首版仅 string/enum/boolean/secret-ref。 */
export type ProviderRuntimeConfig = { enabled?: boolean } & Record<string, unknown>;

/** P2：factory 创建实例时的依赖注入点；P4 起填入 bus/db 等。 */
export type ProviderDeps = Record<string, never>;

/** P2：编译期内置 factory（设计 §2.6）。 */
export interface ProviderFactory {
  manifest: ExecutorProviderManifest;
  parseConfig(raw: unknown): ProviderRuntimeConfig;
  autoDetect(config: ProviderRuntimeConfig): { installed: boolean; ready: boolean; reason?: string };
  create(config: ProviderRuntimeConfig, deps: ProviderDeps): RegisteredProvider;
}

/** P2：运行期实例 = 现有 ExecutorProvider 形态 + manifest；P3+ 迁移到 facet 形态。 */
export type RegisteredProvider = ExecutorProvider & { manifest: ExecutorProviderManifest };

export type RegistryState =
  | "registered"
  | "disabled"
  | "starting"
  | "not_ready"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed";

export interface RegistryEntry {
  id: ProviderId;
  manifest: ExecutorProviderManifest;
  state: RegistryState;
  instance?: RegisteredProvider;
  /** Snapshot refreshed only by provider configuration, never by read-only status projection. */
  runtimeStatus?: ProviderRuntimeStatus;
  failure?: { category: ProviderErrorCategory; message: string };
}

export type ProviderProcessLease = {
  provider: ProviderId;
  invocationOwner: string;
  pid: number;
  pgid?: number;
  startedAt: string;
  commandLabel: string;
};

export type Disposable = { dispose(): void };

export interface ProviderRegistry {
  registerFactory(factory: ProviderFactory): void;
  startConfigured(config: Record<string, ProviderRuntimeConfig | undefined>): Promise<void>;
  refreshConfigured(config: Record<string, ProviderRuntimeConfig | undefined>): Promise<void>;
  setEnabled(id: ProviderId, enabled: boolean, config: ProviderRuntimeConfig): Promise<RegistryEntry>;
  getReady(id: ProviderId): RegisteredProvider;
  readyProviders(): Record<string, RegisteredProvider>;
  describe(id: ProviderId): RegistryEntry;
  list(): RegistryEntry[];
  stopAll(): Promise<void>;
  collectProcessLeases(): readonly ProviderProcessLease[];
  /** 测试注入；生产 build-time 剥离（设计 §2.6）。 */
  injectFactoryForTest(factory: ProviderFactory): Disposable;
}

type FactoryEntry = { factory: ProviderFactory; disposable?: boolean };

function manifestOf(factory: ProviderFactory): ExecutorProviderManifest {
  // 注册期即校验 id 为合法 branded ProviderId（invalid ID fail closed）。
  asProviderId(factory.manifest.id);
  return factory.manifest;
}

/**
 * P2：内存 ProviderRegistry 实现。
 * - registerFactory 只建 catalog；startConfigured 由 factory 自管 parseConfig/autoDetect/create；
 * - duplicate/invalid ID 注册 fail closed；
 * - stopAll 有界容错：单 provider stop 失败记独立 failure，不阻塞其余；
 * - getReady 与 describe 分离：未 ready 不可用，但 catalog 可见。
 */
export function createProviderRegistry(): ProviderRegistry {
  const catalog = new Map<string, FactoryEntry>();
  const entries = new Map<string, RegistryEntry>();

  function entryOf(factory: ProviderFactory): RegistryEntry {
    const manifest = manifestOf(factory);
    const id = manifest.id;
    let entry = entries.get(id);
    if (!entry) {
      entry = { id, manifest, state: "registered" };
      entries.set(id, entry);
    }
    return entry;
  }

  function registerFactory(factory: ProviderFactory): void {
    const id = manifestOf(factory).id;
    if (catalog.has(id)) {
      throw providerRegistryError("duplicate_id", `provider ${id} is already registered`);
    }
    catalog.set(id, { factory });
    entries.set(id, { id, manifest: factory.manifest, state: "registered" });
  }

  async function startConfigured(config: Record<string, ProviderRuntimeConfig | undefined>): Promise<void> {
    const factories = [...catalog.values()].map((f) => f.factory);
    // 并发启动；每个 provider 独立失败状态，不阻塞其余（与 stopAll 同一容错原则）。
    await Promise.all(factories.map((factory) => configureFactory(factory, config[factory.manifest.id] ?? {}, false)));
  }

  async function refreshConfigured(config: Record<string, ProviderRuntimeConfig | undefined>): Promise<void> {
    const factories = [...catalog.values()].map((item) => item.factory);
    await Promise.all(factories.map((factory) => configureFactory(factory, config[factory.manifest.id] ?? {}, true)));
  }

  async function setEnabled(id: ProviderId, enabled: boolean, config: ProviderRuntimeConfig): Promise<RegistryEntry> {
    const factory = catalog.get(id)?.factory;
    if (!factory) throw providerRegistryError("unknown_provider", `provider ${id} is not registered`);
    const entry = entries.get(id);
    if (!entry) throw providerRegistryError("not_found", `provider ${id} is not registered`);
    if (!enabled) {
      try {
        await entry.instance?.stop?.();
        setState(id, "disabled", { clearInstance: true, clearRuntimeStatus: true });
      } catch (err) {
        setState(id, "failed", {
          failure: { category: "stop_failed", message: messageOf(err) }
        });
        throw err;
      }
      return entry;
    }
    await configureFactory(factory, { ...config, enabled: true }, true);
    return entry;
  }

  async function configureFactory(
    factory: ProviderFactory,
    raw: ProviderRuntimeConfig,
    reuseInstance: boolean
  ): Promise<void> {
    const id = factory.manifest.id;
    const entry = entries.get(id);
    try {
      if (raw.enabled === false) {
        setState(id, "disabled", { clearInstance: true, clearRuntimeStatus: true });
        return;
      }
      setState(id, "starting");
      const parsed = factory.parseConfig(raw);
      const probe = factory.autoDetect(parsed);
      if (!probe.installed) {
        setState(id, "not_ready", {
          ...(reuseInstance && entry?.instance ? { instance: entry.instance } : {}),
          clearRuntimeStatus: true,
          failure: { category: "not_ready", message: probe.reason ?? `provider ${id} is not installed` }
        });
        return;
      }
      const instance = reuseInstance && entry?.instance ? entry.instance : factory.create(parsed, {});
      checkManifest(factory.manifest, instance as unknown as Record<string, unknown>);
      const runtime = instance.runtimeStatus?.();
      const ready = probe.ready && runtime?.ready !== false;
      setState(id, ready ? "ready" : "not_ready", {
        instance,
        ...(runtime ? { runtimeStatus: runtime } : { clearRuntimeStatus: true }),
        ...(ready ? {} : {
          failure: {
            category: "not_ready",
            message: runtime?.reason ?? probe.reason ?? `provider ${id} is not ready`
          }
        })
      });
    } catch (err) {
      setState(id, "failed", {
        ...(reuseInstance && entry?.instance ? { instance: entry.instance } : {}),
        failure: { category: categoryOf(err), message: messageOf(err) }
      });
    }
  }

  function setState(
    id: string,
    state: RegistryState,
    patch?: {
      clearInstance?: boolean;
      clearRuntimeStatus?: boolean;
      instance?: RegisteredProvider;
      runtimeStatus?: ProviderRuntimeStatus;
      failure?: RegistryEntry["failure"];
    }
  ): void {
    const entry = entries.get(id);
    if (!entry) return;
    entry.state = state;
    if (patch?.clearInstance) entry.instance = undefined;
    else if (patch?.instance) entry.instance = patch.instance;
    if (patch?.clearRuntimeStatus) entry.runtimeStatus = undefined;
    else if (patch?.runtimeStatus) entry.runtimeStatus = patch.runtimeStatus;
    if (patch?.failure) entry.failure = patch.failure;
    else if (state === "disabled" || state === "ready" || state === "stopped") entry.failure = undefined;
  }

  function getReady(id: ProviderId): RegisteredProvider {
    const entry = entries.get(id);
    if (!entry) {
      throw providerRegistryError("unknown_provider", `provider ${id} is not registered`);
    }
    if (entry.state === "disabled") {
      throw providerRegistryError("disabled", `provider ${id} is disabled by config`);
    }
    if (entry.state === "not_ready") {
      throw providerRegistryError("not_ready", `provider ${id} is not ready (CLI/SDK unavailable)`);
    }
    if (entry.state !== "ready" || !entry.instance) {
      throw providerRegistryError("not_ready", `provider ${id} is not ready (state ${entry.state})`);
    }
    return entry.instance;
  }

  function describe(id: ProviderId): RegistryEntry {
    const entry = entries.get(id);
    if (!entry) {
      throw providerRegistryError("not_found", `provider ${id} is not registered`);
    }
    return entry;
  }

  async function stopAll(): Promise<void> {
    const targets = [...entries.values()].filter(
      (e): e is RegistryEntry & { instance: RegisteredProvider } => !!e.instance
    );
    await Promise.all(
      targets.map(async (entry) => {
        const stop = entry.instance.stop;
        if (typeof stop !== "function") return;
        try {
          await stop.call(entry.instance);
          if (entry.state !== "failed") entry.state = "stopped";
        } catch (err) {
          entry.state = "failed";
          entry.failure = { category: "stop_failed", message: messageOf(err) };
        }
      })
    );
  }

  return {
    registerFactory,
    startConfigured,
    refreshConfigured,
    setEnabled,
    getReady,
    readyProviders: () => Object.fromEntries(
      [...entries.values()]
        .filter((entry): entry is RegistryEntry & { instance: RegisteredProvider } => entry.state === "ready" && !!entry.instance)
        .map((entry) => [String(entry.id), entry.instance])
    ),
    describe,
    list: () => [...entries.values()],
    stopAll,
    collectProcessLeases: () => [...entries.values()].flatMap((entry) => {
      const source = entry.instance as RegisteredProvider & {
        processLeases?: () => readonly Omit<ProviderProcessLease, "provider">[];
      } | undefined;
      if (!source?.processLeases) return [];
      return source.processLeases().map((lease) => ({ ...lease, provider: entry.id }));
    }),
    injectFactoryForTest(factory: ProviderFactory): Disposable {
      if (catalog.has(factory.manifest.id)) {
        throw providerRegistryError("duplicate_id", `provider ${factory.manifest.id} is already registered`);
      }
      catalog.set(factory.manifest.id, { factory, disposable: true });
      entries.set(factory.manifest.id, { id: factory.manifest.id, manifest: factory.manifest, state: "registered" });
      return {
        dispose: () => {
          catalog.delete(factory.manifest.id);
          entries.delete(factory.manifest.id);
        }
      };
    }
  };
}

function categoryOf(err: unknown): ProviderErrorCategory {
  if (err instanceof Error && "category" in err && typeof (err as { category: string }).category === "string") {
    return (err as { category: ProviderErrorCategory }).category;
  }
  return "startup_failed";
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "unknown error";
}

export function registryEntryId(id: string): ProviderId {
  return asProviderId(id);
}
