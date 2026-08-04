import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_VERSION = "unknown";
const ARTIFACT_NAME = "xuanwu";

export type BunBuildInfo = {
  artifact: string;
  bun_version: string;
  stamp: string;
  version: string;
};

export function bunBuildInfo(): BunBuildInfo {
  return {
    artifact: ARTIFACT_NAME,
    bun_version: Bun.version,
    stamp: clean(process.env.XUANWU_BUILD_STAMP) ?? "",
    version: resolveBuildVersion()
  };
}

export function resolveBuildVersion(): string {
  return clean(process.env.XUANWU_BUILD_VERSION) ?? gitDescribeVersion() ?? DEFAULT_VERSION;
}

export function formatBunVersion(): string {
  const build = bunBuildInfo();
  const stamp = build.stamp === "" ? "dev" : build.stamp;
  return `${build.artifact} ${build.version} build=${stamp} bun=${build.bun_version}\n`;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

function gitDescribeVersion(): string | undefined {
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const result = Bun.spawnSync(["git", "-C", rootDir, "describe", "--tags", "--dirty", "--always"], {
    stderr: "pipe",
    stdout: "pipe"
  });
  if (result.exitCode !== 0) return undefined;
  return clean(new TextDecoder().decode(result.stdout));
}
