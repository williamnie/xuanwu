import type { RemoteNode } from "../db/repositories/nodes.ts";
import { catalogEntryFromRegistry, type ProviderCatalogEntry } from "../providers/core/catalog.ts";
import type { ProviderCapabilities } from "../providers/core/manifest.ts";
import { asProviderId } from "../providers/types.ts";
import { remoteProviderManifest } from "./remoteProvider.ts";

type NodeProviderCatalogEntry = ProviderCatalogEntry & { node_id: string; node_online: boolean };

/** 就绪性取最后一次 hello；在线状态单独返回，离线不阻止用户创建待执行任务。名称带节点名，与本机同名工具区分。 */
export function catalogForRemoteNode(node: RemoteNode, online: boolean): NodeProviderCatalogEntry[] {
  return node.info.providers
    .filter((provider) => provider.ready && provider.capabilities.includes("issue_execution"))
    .map((provider) => {
      const has = (capability: string) => provider.capabilities.includes(capability);
      const reads = new Set(provider.read_methods ?? []);
      const sessions = new Set(provider.session_methods ?? []);
      const capabilities: ProviderCapabilities = {
        issueExecution: true,
        sessions: {
          create: has("sessions") && sessions.has("createSession"),
          list: reads.has("listSessions"),
          read: reads.has("readSession"),
          resume: has("resume_session")
        },
        control: { interrupt: has("interrupt"), approvals: has("approvals") ? "host-callback" : "none" },
        models: { list: has("model_list") && reads.has("listModels") }
      };
      const builtin = remoteProviderManifest(provider.id);
      return {
        ...catalogEntryFromRegistry({
          id: asProviderId(provider.id),
          state: "ready",
          manifest: {
            id: asProviderId(provider.id),
            displayName: `${node.name} · ${builtin?.displayName ?? provider.id}`,
            supportLevel: builtin?.supportLevel ?? "experimental",
            transports: ["rpc"],
            capabilities,
            ...(builtin?.executionSettings ? { executionSettings: builtin.executionSettings } : {}),
            ...(builtin?.executionPolicy ? { executionPolicy: builtin.executionPolicy } : {})
          },
          runtimeStatus: {
            active_sessions: 0,
            api_key_configured: false,
            mode: "remote",
            ready: online,
            version: provider.version ?? "",
            ...(!online ? { reason: "node offline" } : {})
          }
        }),
        node_id: node.id,
        node_online: online
      };
    });
}
