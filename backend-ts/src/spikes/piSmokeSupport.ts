import { type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
const PI_PACKAGE_DIR_ENV = "PI_PACKAGE_DIR";
const PI_PACKAGE_ASSET_DIR = "pi-coding-agent";
const PI_PACKAGE_RELATIVE_DIR = join("backend-ts", "node_modules", "@earendil-works", "pi-coding-agent");

export type SmokeRuntime = {
  ai: typeof import("@earendil-works/pi-ai/compat");
  pi: typeof import("@earendil-works/pi-coding-agent");
};

export function resolveDefaultRepoRoot(fallbackCwd = ""): string {
  if (!isCompiledBunExecutable()) return resolve(import.meta.dirname, "../../..");

  const cwd = process.cwd();
  const current = basename(cwd) === "backend-ts" ? resolve(cwd, "..") : cwd;
  if (hasPiPackage(current)) return current;
  return hasPiPackage(fallbackCwd) ? resolve(fallbackCwd) : current;
}

export async function loadSmokeRuntime(repoRoot: string): Promise<SmokeRuntime> {
  ensurePiPackageDir(repoRoot);
  const [pi, ai, { registerBunOAuthFlows }] = await Promise.all([
    import("@earendil-works/pi-coding-agent"),
    import("@earendil-works/pi-ai/compat"),
    import("@earendil-works/pi-ai/bun-oauth")
  ]);
  registerBunOAuthFlows();
  return { ai, pi };
}

function isCompiledBunExecutable(): boolean {
  return import.meta.url.includes("$bunfs") ||
    import.meta.url.includes("~BUN") ||
    import.meta.url.includes("%7EBUN");
}

function ensurePiPackageDir(repoRoot: string): void {
  if (process.env[PI_PACKAGE_DIR_ENV]) return;

  const packageDir = resolvePiPackageAssetDir(repoRoot);
  if (packageDir !== "") process.env[PI_PACKAGE_DIR_ENV] = packageDir;
}

export function resolvePiPackageAssetDir(
  repoRoot: string,
  options: { cwd?: string; execPath?: string } = {}
): string {
  const execDir = dirname(options.execPath ?? process.execPath);
  const candidates = [
    join(execDir, PI_PACKAGE_ASSET_DIR),
    join(dirname(execDir), PI_PACKAGE_ASSET_DIR),
    join(repoRoot, PI_PACKAGE_RELATIVE_DIR),
    join(options.cwd ?? process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent")
  ];
  return candidates.find(hasPackageRoot) ?? "";
}

function hasPiPackage(path: string): boolean {
  return path.trim() !== "" && existsSync(join(path, PI_PACKAGE_RELATIVE_DIR, "package.json"));
}

function hasPackageRoot(path: string): boolean {
  return path.trim() !== "" && existsSync(join(path, "package.json"));
}
