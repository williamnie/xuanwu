const DEFAULT_VERSION = "0.0.0-dev";
const ARTIFACT_NAME = "codex-issue-runner-bun";

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
    stamp: clean(process.env.CODEX_RUNNER_BUN_BUILD_STAMP) ?? "",
    version: clean(process.env.CODEX_RUNNER_BUN_BUILD_VERSION) ?? DEFAULT_VERSION
  };
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
