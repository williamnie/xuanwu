import { connect } from "node:net";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import { detectProviderCommand } from "../core/command.ts";
import { inspectClaudeCliAuth } from "./cliProvider.ts";

export const HERDR_INSTALL_HINT = "herdr 原生终端模式依赖用户自行安装并启动 herdr（https://herdr.dev/docs/install/），玄武不会自动安装。请在执行节点、同一系统用户下运行 herdr，并确认 claude 已登录。";
export type HerdrProbe = { ready: boolean; reason?: string; version: string; claude: string; curl: string; socket: string };
export type HerdrRpc = (method: string, params: Record<string, unknown>) => Promise<Record<string, any>>;
type ProbeDependencies = {
  which: (name: string) => string | null;
  isSocket: (path: string) => boolean;
  command: typeof detectProviderCommand;
  run: (argv: string[], env: Record<string, string | undefined>) => { exitCode: number; stdout: string };
  auth: typeof inspectClaudeCliAuth;
};
const probeDependencies: ProbeDependencies = {
  which: (name) => Bun.which(name), isSocket: (path) => statSync(path).isSocket(),
  command: detectProviderCommand, auth: inspectClaudeCliAuth,
  run: (argv, env) => {
    const result = Bun.spawnSync(argv, { env, timeout: 3000, maxBuffer: 1024 * 1024, stdout: "pipe", stderr: "pipe" });
    return { exitCode: result.exitCode, stdout: result.stdout.toString() };
  }
};

export function herdrSocket(env: Record<string, string | undefined>): string {
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  const base = join(env.XDG_CONFIG_HOME || join(env.HOME || "", ".config"), "herdr");
  const session = env.HERDR_SESSION;
  if (session && !/^[a-zA-Z0-9_-]+$/.test(session)) throw new Error("Invalid HERDR_SESSION; use HERDR_SOCKET_PATH for an explicit socket");
  return session ? join(base, "sessions", session, "herdr.sock") : join(base, "herdr.sock");
}

/** 只检查依赖，不安装、不启动服务，不把外部命令输出（可能含凭据）投影给 UI。 */
export function inspectHerdr(config: ProviderRuntimeConfig, deps = probeDependencies): HerdrProbe {
  const env = { ...Bun.env, ...config.env };
  const result: HerdrProbe = { ready: false, version: "", claude: "", curl: "", socket: "" };
  const fail = (reason: string) => ({ ...result, reason: `${reason} ${HERDR_INSTALL_HINT}` });
  if (process.platform === "win32") return fail("当前 herdr adapter 仅支持 macOS/Linux。");
  // 首版仅复用当前用户登录；不把 API 密钥通过终端命令行注入。
  if (config.authMode && config.authMode !== "local-cli") return fail("herdr 模式需要 XUANWU_CLAUDE_AUTH_MODE=local-cli。");
  for (const key of ["HOME", "CLAUDE_CONFIG_DIR"]) {
    if (config.env[key] && config.env[key] !== Bun.env[key]) return fail(`herdr 模式的 ${key} 必须与玄武服务一致，以便读取同一原生会话历史。`);
  }
  const herdr = deps.which("herdr");
  if (!herdr) return fail("未检测到 herdr，请将其加入玄武服务的 PATH。");
  const claude = deps.command(config.command || "claude");
  if (!claude.installed || !claude.path) return fail("未检测到 Claude Code CLI。");
  result.claude = claude.path;
  result.curl = deps.which("curl") || "";
  if (!result.curl) return fail("缺少 curl（本地 hooks 回调需要）。");
  try {
    result.socket = herdrSocket(env);
    if (!deps.isSocket(result.socket)) return fail("herdr socket 不可用。");
    const version = deps.run([herdr, "--version"], env);
    const match = version.stdout.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
    if (version.exitCode !== 0 || !match) return fail("无法确定 herdr 版本。");
    result.version = match[0];
    if (Number(match[1]) === 0 && (Number(match[2]) < 9 || (Number(match[2]) === 9 && Number(match[3]) < 5))) return fail("需要 herdr 0.9.5 或更新版本。");
    const ping = deps.run([herdr, "api", "snapshot"], { ...env, HERDR_SOCKET_PATH: result.socket });
    if (ping.exitCode !== 0 || !JSON.parse(ping.stdout).result) return fail("herdr 服务无响应或 API 不兼容。");
    const auth = deps.auth({ ...config, command: result.claude, authMode: "local-cli" });
    if (!auth.checked || !auth.logged_in) return fail("无法确认 Claude 登录，请以服务用户运行 claude auth login。");
    return { ...result, ready: true };
  } catch { return fail("herdr 服务未启动或 socket 不可访问。"); }
}

/** Herdr 是 NDJSON 请求协议，并非 JSON-RPC 2.0。超时结果未知，调用方不得自动重发写操作。 */
export function herdrRequest(path: string, method: string, params: Record<string, unknown>, timeoutMs = 35_000): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const socket = connect(path);
    let buffer = "";
    let settled = false;
    const finish = (error?: Error, result?: Record<string, any>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error(`herdr ${method} timed out; outcome unknown, inspect the terminal before retrying`)), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify({ id, method, params }) + "\n"));
    socket.on("error", () => finish(new Error(`herdr ${method}: socket unavailable`)));
    socket.on("close", () => finish(new Error(`herdr ${method}: connection closed before acknowledgement`)));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) return finish(new Error("herdr response exceeds 2 MiB"));
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.id !== id) continue;
          if (message.error) return finish(new Error(`herdr ${method} rejected the request`));
          if (!message.result || typeof message.result !== "object") return finish(new Error("Invalid herdr response"));
          finish(undefined, message.result);
        } catch { finish(new Error("Invalid herdr JSON response")); }
      }
    });
  });
}

export function shellQuote(value: string): string {
  if (value.includes("\0")) throw new Error("NUL is not allowed in terminal arguments");
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
