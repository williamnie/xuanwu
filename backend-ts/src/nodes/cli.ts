import { readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { bunBuildInfo } from "../buildInfo.ts";
import type { ExecutorProvider } from "../providers/types.ts";
import { NodeAgent, NodeAgentFatalError, type NodeAgentOptions } from "./agent.ts";
import { nodeExecutionHandlers, nodeProviderInfo } from "./nodeExecutor.ts";
import { startNodeProviders } from "./nodeProviders.ts";

export type NodeCliConfig = { allowedRoots: string[]; hubUrl: string; token: string };

const USAGE = `usage: xuanwu node [--hub <url>] [--token <key>] [--root <dir>]... [--config <file>]

  --hub      中心地址，例如 http://100.64.0.1:8787
  --token    添加节点时中心给出的密钥（也可用环境变量 XUANWU_NODE_TOKEN，避免出现在进程列表中）
  --root     允许中心在其中运行 agent 的目录，可重复；未配置时拒绝所有项目
  --config   配置文件，默认 ~/.xuanwu/node.json：{"hub": "...", "token": "...", "roots": ["..."]}
`;

export async function runNodeCommand(args: string[], env: Record<string, string | undefined> = Bun.env): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  let config: NodeCliConfig;
  try {
    config = await resolveNodeCliConfig(args, env);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  const registry = await startNodeProviders();
  const agent = new NodeAgent(nodeAgentOptions(config, () => registry.readyProviders()));
  process.once("SIGINT", () => agent.stop());
  process.once("SIGTERM", () => agent.stop());
  try {
    await agent.run();
    return 0;
  } catch (error) {
    if (error instanceof NodeAgentFatalError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    await registry.stopAll();
  }
}

/** 命令行参数优先于环境变量，环境变量优先于配置文件。 */
export async function resolveNodeCliConfig(args: string[], env: Record<string, string | undefined>): Promise<NodeCliConfig> {
  const flags = parseFlags(args);
  const configPath = flags.config ?? join(env.HOME || homedir(), ".xuanwu", "node.json");
  const file = await readConfigFile(configPath, flags.config !== undefined);
  const hubUrl = (flags.hub ?? env.XUANWU_NODE_HUB ?? stringField(file.hub)).trim();
  const token = (flags.token ?? env.XUANWU_NODE_TOKEN ?? stringField(file.token)).trim();
  const allowedRoots = flags.roots.length > 0
    ? flags.roots
    : Array.isArray(file.roots) ? file.roots.filter((root): root is string => typeof root === "string" && root.trim() !== "") : [];
  if (hubUrl === "") throw new Error("missing hub address (--hub)");
  if (!/^https?:\/\//.test(hubUrl)) throw new Error("hub address must start with http:// or https://");
  if (token === "") throw new Error("missing node token (--token or XUANWU_NODE_TOKEN)");
  return { allowedRoots, hubUrl, token };
}

function nodeAgentOptions(config: NodeCliConfig, providers: () => Record<string, ExecutorProvider>): NodeAgentOptions {
  if (config.allowedRoots.length === 0) {
    console.warn(JSON.stringify({ event: "node.no_allowed_roots", message: "no --root configured; the hub cannot run agents on this node" }));
  }
  return {
    ...config,
    handlers: nodeExecutionHandlers(providers),
    info: () => ({ hostname: hostname(), os: process.platform, providers: nodeProviderInfo(providers()), version: bunBuildInfo().version })
  };
}

function parseFlags(args: string[]): { config?: string; hub?: string; roots: string[]; token?: string } {
  const result: { config?: string; hub?: string; roots: string[]; token?: string } = { roots: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const [name, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`missing value for ${name}`);
      index += 1;
      return next;
    };
    if (name === "--hub") result.hub = value();
    else if (name === "--token") result.token = value();
    else if (name === "--root") result.roots.push(value());
    else if (name === "--config") result.config = value();
    else throw new Error(`unknown option: ${arg}`);
  }
  return result;
}

async function readConfigFile(path: string, required: boolean): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`cannot read node config ${path}`);
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`node config ${path} must be a JSON object`);
  return parsed as Record<string, unknown>;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}
