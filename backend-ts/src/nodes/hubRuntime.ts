import type { RunnerDatabase } from "../db/database.ts";
import { getRemoteNode } from "../db/repositories/nodes.ts";
import { listProjects } from "../db/repositories/projects.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { NodeHub } from "./hub.ts";
import { projectLocation } from "./projectLocation.ts";
import { installRemoteProviderResolver } from "./remoteExecution.ts";
import { remoteProvidersForNode } from "./remoteProvider.ts";

type ProviderMap = Partial<Record<ExecutorProviderId, ExecutorProvider>>;

type HubRuntimeOptions = {
  database: RunnerDatabase;
  /** 节点上线时唤醒其项目的任务循环（排队中的任务在节点离线期间等待）。 */
  onNodeOnline?: (projectIds: string[]) => void;
};

/**
 * Core 侧的节点运行时：创建 NodeHub，并安装「项目 → 节点 provider」解析器。
 * 远程 provider 按节点最近一次握手上报的信息构建，握手更新后重建。
 */
export function startNodeHubRuntime(options: HubRuntimeOptions): { hub: NodeHub; stop(): void } {
  const hub = new NodeHub();
  const cache = new Map<string, { providers: ProviderMap; version: string }>();
  const uninstall = installRemoteProviderResolver((nodeId) => {
    const node = getRemoteNode(options.database, nodeId);
    if (!node || node.revoked_at !== "") return {};
    const cached = cache.get(nodeId);
    if (cached?.version === node.updated_at) return cached.providers;
    const providers = remoteProvidersForNode(hub, node);
    cache.set(nodeId, { providers, version: node.updated_at });
    return providers;
  });
  const stopWatching = hub.onStatusChange((nodeId, online) => {
    if (!online || !options.onNodeOnline) return;
    const projectIds = listProjects(options.database)
      .filter((project) => projectLocation(project.cwd).nodeId === nodeId)
      .map((project) => project.id);
    if (projectIds.length > 0) options.onNodeOnline(projectIds);
  });
  return {
    hub,
    stop() {
      stopWatching();
      uninstall();
    }
  };
}
