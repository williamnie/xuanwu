/**
 * 远程项目的 cwd 以 `node://<节点ID>:<节点上的绝对路径>` 存在 projects.cwd 中。
 * - 沿用 projects.cwd 的唯一约束，天然按「节点 + 路径」唯一，无需重建被大量外键引用的 projects 表；
 * - 中心上直接读写目录的代码遇到该前缀只会找不到目录，不会误操作中心本机的同名目录。
 */
const REMOTE_CWD_PATTERN = /^node:\/\/(node_[a-z0-9]{1,32}):(.+)$/;

export type ProjectLocation = { nodeId: ""; path: string } | { nodeId: string; path: string };

export function remoteProjectCwd(nodeId: string, path: string): string {
  if (!/^node_[a-z0-9]{1,32}$/.test(nodeId)) throw new Error("invalid node id");
  if (path.trim() === "" || path.includes("\0")) throw new Error("invalid node path");
  return `node://${nodeId}:${path}`;
}

export function projectLocation(cwd: string): ProjectLocation {
  const match = REMOTE_CWD_PATTERN.exec(cwd);
  return match ? { nodeId: match[1]!, path: match[2]! } : { nodeId: "", path: cwd };
}

export function isRemoteProjectCwd(cwd: string | undefined | null): boolean {
  return typeof cwd === "string" && REMOTE_CWD_PATTERN.test(cwd);
}
