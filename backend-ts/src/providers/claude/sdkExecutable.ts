import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cleanString } from "../../util/values.ts";

export function resolveClaudeSdkExecutable(): string {
  const configured = cleanString(Bun.env.XUANWU_CLAUDE_SDK_EXECUTABLE);
  if (configured) return isRegularFile(configured) ? configured : "";
  const bundled = bundledClaudeSdkExecutable();
  return compatibleSystemClaude(bundled) || bundled;
}

/**
 * 优先用用户终端里的 claude，让玄武与终端共用同一版本、配置与会话格式；
 * 只接受与 SDK 自带 CLI 同主次版本且不更旧的版本，否则回退到自带 CLI。
 * XUANWU_CLAUDE_SDK_USE_SYSTEM=0 可强制只用自带 CLI。
 */
export function compatibleSystemClaude(bundled: string): string {
  if (cleanString(Bun.env.XUANWU_CLAUDE_SDK_USE_SYSTEM) === "0") return "";
  const candidate = [cleanString(Bun.which("claude") ?? ""), join(homedir(), ".local", "bin", "claude")]
    .find((path) => path !== "" && isRegularFile(path)) ?? "";
  if (candidate === "") return "";
  const system = claudeCliVersion(candidate);
  if (!system) return "";
  const required = bundled ? claudeCliVersion(bundled) : undefined;
  if (!required) return candidate;
  const compatible = system[0] === required[0] && system[1] === required[1] && system[2] >= required[2];
  return compatible ? candidate : "";
}

export const cliVersionCache = new Map<string, [number, number, number] | undefined>();

export function claudeCliVersion(path: string): [number, number, number] | undefined {
  let cacheKey = path;
  try {
    cacheKey = `${path}\0${statSync(path).mtimeMs}`;
  } catch {
    return undefined;
  }
  if (cliVersionCache.has(cacheKey)) return cliVersionCache.get(cacheKey);
  let version: [number, number, number] | undefined;
  try {
    const result = Bun.spawnSync([path, "--version"], { stdout: "pipe", stderr: "ignore", timeout: 5_000 });
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(result.stdout.toString());
    if (result.exitCode === 0 && match) version = [Number(match[1]), Number(match[2]), Number(match[3])];
  } catch {
    version = undefined;
  }
  cliVersionCache.set(cacheKey, version);
  return version;
}

export function bundledClaudeSdkExecutable(): string {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const adjacent = `${process.execPath}.claude-agent-sdk${suffix}`;
  if (isRegularFile(adjacent)) return adjacent;
  const packageName = claudeSdkNativePackage();
  if (!packageName) return "";
  try {
    const resolved = Bun.resolveSync(`${packageName}/claude${suffix}`, import.meta.dir);
    return isRegularFile(resolved) ? resolved : "";
  } catch {
    return "";
  }
}

export function claudeSdkNativePackage(): string {
  const arch = process.arch === "x64" || process.arch === "arm64" ? process.arch : "";
  if (!arch || !["darwin", "linux", "win32"].includes(process.platform)) return "";
  return `@anthropic-ai/claude-agent-sdk-${process.platform}-${arch}`;
}

export function isRegularFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
