import { NodeOfflineError } from "./hub.ts";
import { projectLocation } from "./projectLocation.ts";
import type { NodeGitRunResult } from "./nodeGit.ts";

/** rejected：节点拒绝执行（越出 allowedRoots、命令不在白名单等）的原因。 */
export type RemoteGitResult = { rejected?: string; status: number | null; stderr: string; stdout: Buffer };
type RemoteGitRunner = (nodeId: string, input: { args: string[]; path: string; stdoutLimit: number; timeoutMs: number }) => Promise<NodeGitRunResult>;

/**
 * 中心验收链路对远程项目执行 git 的唯一入口：Core 启动时由节点运行时安装。
 * 节点离线或未安装时返回 null，调用方按「观察不可用」处理，与本机 git 失败语义一致。
 */
let runner: RemoteGitRunner | undefined;

export function installRemoteGitRunner(next: RemoteGitRunner): () => void {
  runner = next;
  return () => {
    if (runner === next) runner = undefined;
  };
}

export async function runRemoteGit(
  cwd: string,
  args: string[],
  options: { stdoutLimit: number; timeoutMs: number }
): Promise<RemoteGitResult | null> {
  const { nodeId, path } = projectLocation(cwd);
  if (nodeId === "" || !runner || options.timeoutMs <= 0) return null;
  try {
    const result = await runner(nodeId, { args, path, stdoutLimit: options.stdoutLimit, timeoutMs: options.timeoutMs });
    return { status: result.status, stderr: result.stderr, stdout: Buffer.from(result.stdout, "base64") };
  } catch (error) {
    if (error instanceof NodeOfflineError) return null;
    const message = error instanceof Error ? error.message : String(error);
    return { rejected: message, status: null, stderr: message, stdout: Buffer.alloc(0) };
  }
}
