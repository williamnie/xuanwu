import { statSync } from "node:fs";
import { splitCommand } from "../codex/jsonRpc.ts";
import { cleanString } from "../../util/values.ts";
import { ClaudeProcessFactory, ClaudeProcess } from "./cliProviderModel.ts";

export function assertUsableCwd(cwd: string): void {
  const path = cleanString(cwd);
  if (path === "") throw new Error("Claude Code issue run blocked: cwd is required");
  try {
    if (statSync(path).isDirectory()) return;
  } catch {
    // fall through to stable sanitized error below
  }
  throw new Error(`Claude Code issue run blocked: cwd unavailable: ${path}`);
}

export function safeLabel(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_. -]{1,64}$/.test(text) ? text : "";
}

export function safeAuthMethod(value: unknown): string {
  const method = safeLabel(value);
  return method === "oauth_token" ? "oauth" : method;
}

export function spawnClaudeProcess({ command, cwd, env }: Parameters<ClaudeProcessFactory>[0]): ClaudeProcess {
  return Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
}

export function claudeCommandAvailable(command: string): boolean {
  const executable = splitCommand(command)[0] ?? "";
  if (executable === "") return false;
  if (!executable.includes("/")) return Boolean(Bun.which(executable));
  try {
    const stat = statSync(executable);
    return stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}
