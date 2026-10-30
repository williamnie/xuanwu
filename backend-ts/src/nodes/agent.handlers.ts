import { stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { NodeAgentFatalError } from "./agent.model.ts";
import type { NodeCommandHandler } from "./agent.model.ts";

export type NodePathCheckResult = { directory: boolean; exists: boolean; git_repo: boolean; path: string };

export const builtinHandlers: Record<string, NodeCommandHandler> = {
  // 与中心本机的项目路径检查同形；只有越出 allowedRoots 才报错，不存在的路径如实返回 exists=false。
  "path.check": async (params, agent): Promise<NodePathCheckResult> => {
    const path = String((isRecord(params) ? params.path : undefined) ?? "");
    if (!isAbsolute(path) || path.includes("\0")) throw new Error("path must be absolute");
    const entry = await stat(path).catch(() => null);
    if (!entry) {
      if (!agent.allowedRoots.some((root) => isWithin(root, resolve(path)))) throw new Error("path is outside the node's allowed roots");
      return { directory: false, exists: false, git_repo: false, path: resolve(path) };
    }
    const resolved = await agent.resolveAllowedPath(path);
    const directory = entry.isDirectory();
    const git = directory ? await stat(join(resolved, ".git")).catch(() => null) : null;
    return { directory, exists: true, git_repo: Boolean(git?.isDirectory() || git?.isFile()), path: resolved };
  }
};

export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  const message = await response.text().catch(() => "");
  if (response.status === 401) throw new NodeAgentFatalError("hub rejected the node token (revoked or wrong)");
  if (response.status === 409) throw new NodeAgentFatalError(message || "protocol mismatch with hub");
  throw new Error(`hub responded ${response.status}${message ? `: ${message.slice(0, 200)}` : ""}`);
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep) => {
    const timer = setTimeout(resolveSleep, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolveSleep();
    }, { once: true });
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
