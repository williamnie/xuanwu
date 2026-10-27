import type { RunnerDatabase } from "../db/database.ts";
import { getProject } from "../db/repositories/projects.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { projectLocation } from "./projectLocation.ts";

type ProviderMap = Partial<Record<ExecutorProviderId, ExecutorProvider>>;
type RemoteProviderResolver = (nodeId: string) => ProviderMap;

/**
 * Core 启动时安装一次。provider map 在各调用方之间按引用传递，
 * 这里按项目所在节点替换成该节点的远程 provider，调用方无需感知远程项目。
 */
let resolver: RemoteProviderResolver | undefined;

export function installRemoteProviderResolver(next: RemoteProviderResolver): () => void {
  resolver = next;
  return () => {
    if (resolver === next) resolver = undefined;
  };
}

/** 调用方传入的 provider map 可能只声明了部分方法；远程 provider 是完整实现，可安全收窄回同一类型。 */
type AnyProviderMap = Partial<Record<ExecutorProviderId, Partial<ExecutorProvider>>> | undefined;

/** 本机项目原样返回中心的 provider；远程项目只返回其节点上的 provider（节点未知时为空）。 */
export function providersForProjectCwd<T extends AnyProviderMap>(providers: T, cwd: string): NonNullable<T> | T {
  const { nodeId } = projectLocation(cwd);
  if (nodeId === "") return providers;
  return (resolver?.(nodeId) ?? {}) as NonNullable<T>;
}

export function providersForProjectID<T extends AnyProviderMap>(
  db: RunnerDatabase,
  providers: T,
  projectId: string
): NonNullable<T> | T {
  const cwd = projectId.trim() === "" ? "" : getProject(db, projectId)?.cwd ?? "";
  return providersForProjectCwd(providers, cwd);
}
