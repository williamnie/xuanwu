import { runBoundedProcess } from "../util/boundedProcess.ts";
import type { NodeCommandHandler } from "./agent.ts";

/**
 * 中心验收链路需要的只读 git 子命令。节点只执行这些，且固定加上与中心本机相同的安全参数，
 * 不开放任何会改写仓库、索引或引用的命令。
 */
const READ_ONLY_SUBCOMMANDS = new Set([
  "cat-file", "diff", "diff-tree", "for-each-ref", "hash-object", "log", "ls-files", "ls-tree",
  "merge-base", "rev-list", "rev-parse", "show", "show-ref", "status", "symbolic-ref"
]);
/** 这些参数会让只读子命令产生写入或执行外部程序。 */
const FORBIDDEN_ARGUMENTS = [/^-w$/, /^--write/, /^--output/, /^--ext-diff$/, /^--textconv$/, /^-c$/, /^--exec/, /^--upload-pack/];

const MAX_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export type NodeGitRunParams = { args: string[]; path: string; stdoutLimit?: number; timeoutMs?: number };
export type NodeGitRunResult = { status: number | null; stderr: string; stdout: string; timedOut?: boolean };

export const nodeGitHandlers: Record<string, NodeCommandHandler> = {
  "git.run": async (params, agent): Promise<NodeGitRunResult> => {
    const input = parseGitRun(params);
    const cwd = await agent.resolveAllowedPath(input.path);
    const result = await runBoundedProcess({
      command: "git",
      args: ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external=", ...input.args],
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      input: "",
      stderrLimit: 64 * 1024,
      stdoutLimit: Math.min(input.stdoutLimit ?? MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES),
      timeoutMs: Math.min(input.timeoutMs ?? 10_000, MAX_TIMEOUT_MS)
    });
    // 与中心本机 runGit 相同按 UTF-8 解码；含 NUL 分隔的输出经 base64 原样回传。
    return {
      status: result.error ? null : result.status,
      stderr: result.stderr.slice(0, 4_096),
      stdout: Buffer.from(result.stdout, "utf8").toString("base64"),
      ...(result.error?.code === "ETIMEDOUT" ? { timedOut: true } : {})
    };
  }
};

function parseGitRun(params: unknown): NodeGitRunParams {
  const value = params as Partial<NodeGitRunParams> | null;
  const args = Array.isArray(value?.args) ? value.args : [];
  if (typeof value?.path !== "string" || args.length === 0 || !args.every((arg) => typeof arg === "string")) {
    throw new Error("invalid git.run params");
  }
  if (!READ_ONLY_SUBCOMMANDS.has(args[0]!)) throw new Error(`git ${args[0]} is not allowed on nodes`);
  const forbidden = args.find((arg) => FORBIDDEN_ARGUMENTS.some((pattern) => pattern.test(arg)));
  if (forbidden) throw new Error(`git argument ${forbidden} is not allowed on nodes`);
  return {
    args,
    path: value.path,
    ...(typeof value.stdoutLimit === "number" ? { stdoutLimit: value.stdoutLimit } : {}),
    ...(typeof value.timeoutMs === "number" ? { timeoutMs: value.timeoutMs } : {})
  };
}
