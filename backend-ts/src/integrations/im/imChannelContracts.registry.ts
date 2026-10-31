import { assertConnectorConformance, type ConnectorCapability } from "../channelConnectorContracts.ts";
import { cleanString } from "../../util/values.ts";
import type { ImChannelRegistryOptions, ImChannelModule, ImCapabilityId, ImReceiverStatus } from "./imChannelContracts.model.ts";
import { validateConfigurationDescriptor } from "./imChannelContracts.validation.ts";

/**
 * Compile-time built-in registry. Registration is explicit; duplicate ids,
 * manifest mismatches and missing capabilities fail closed. The registry hands
 * out only the connector/presentation contracts — never provider clients.
 */
export function createImChannelRegistry(options: ImChannelRegistryOptions = {}) {
  const modules = new Map<string, ImChannelModule>();

  function register(module: ImChannelModule): void {
    if (!module || typeof module !== "object") throw new Error("im channel module is required");
    const id = cleanString(module.id);
    if (id === "") throw new Error("im channel module id is required");
    if (modules.has(id)) throw new Error(`im channel module is already registered: ${id}`);
    if (!module.connector || typeof module.connector !== "object") throw new Error(`im channel module ${id} is missing connector`);
    if (module.connector.manifest.id !== id) {
      throw new Error(`im channel module id ${id} does not match connector manifest id ${module.connector.manifest.id}`);
    }
    assertConnectorConformance(module.connector);
    for (const capability of options.require ?? []) {
      if (!declaresCapability(module.connector.manifest.capabilities, capability)) {
        throw new Error(`im channel module ${id} is missing required capability ${capability}`);
      }
    }
    if (!module.receiver || typeof module.receiver.status !== "function") {
      throw new Error(`im channel module ${id} is missing receiver`);
    }
    if (!module.presentation || typeof module.presentation.deliver !== "function") {
      throw new Error(`im channel module ${id} is missing presentation adapter`);
    }
    if (!module.configuration || !["none", "provider_specific"].includes(module.configuration.mode)) {
      throw new Error(`im channel module ${id} is missing configuration descriptor`);
    }
    if (module.configuration.mode === "provider_specific" && !module.configuration.settings_path.startsWith("/api/")) {
      throw new Error(`im channel module ${id} has invalid settings path`);
    }
    validateConfigurationDescriptor(id, module.configuration.fields);
    if (module.callback && !module.callback.path.startsWith("/api/integrations/")) {
      throw new Error(`im channel module ${id} has invalid callback path`);
    }
    modules.set(id, module);
  }

  function get(id: string): ImChannelModule {
    const module = modules.get(cleanString(id));
    if (!module) throw new Error(`im channel module is not registered: ${cleanString(id) || "(empty)"}`);
    return module;
  }

  function list(): ImChannelModule[] {
    return [...modules.values()];
  }

  return { get, has: (id: string) => modules.has(cleanString(id)), list, register };
}

export type ImChannelRegistry = ReturnType<typeof createImChannelRegistry>;

export function declaresCapability(capabilities: ConnectorCapability[], id: ImCapabilityId): boolean {
  return capabilities.some((capability) => capability.id === id);
}

/**
 * Registry-driven receiver lifecycle (design §5.7): each module has at most
 * one active receiver generation; health/status stay in-memory projections.
 */
export function createImReceiverRuntime(registry: ImChannelRegistry) {
  return {
    status(connectorId?: string): ImReceiverStatus[] {
      const modules = connectorId === undefined
        ? registry.list()
        : registry.has(connectorId) ? [registry.get(connectorId)] : [];
      return modules.map((module) => ({ ...module.receiver.status(), connector_id: module.id }));
    },
    async start(): Promise<void> {
      for (const module of registry.list()) {
        await module.notifications?.start();
        await module.receiver.start();
      }
    },
    async stop(): Promise<void> {
      for (const module of [...registry.list()].reverse()) {
        await module.receiver.stop();
        await module.notifications?.stop();
      }
    },
    async restart(connectorId: string): Promise<void> {
      await registry.get(connectorId).receiver.restart();
    }
  };
}

export type ImReceiverRuntime = ReturnType<typeof createImReceiverRuntime>;
