import { describe, expect, test } from "bun:test";
import { bunBuildInfo, formatBunVersion, resolveBuildVersion } from "./buildInfo.ts";

const ORIGINAL_BUILD_VERSION = process.env.CODEX_RUNNER_BUILD_VERSION;
const OLD_DEV_VERSION = "0.0.0-dev";

function withBuildVersion(value: string | undefined, fn: () => void) {
  if (value === undefined) {
    delete process.env.CODEX_RUNNER_BUILD_VERSION;
  } else {
    process.env.CODEX_RUNNER_BUILD_VERSION = value;
  }
  try {
    fn();
  } finally {
    if (ORIGINAL_BUILD_VERSION === undefined) {
      delete process.env.CODEX_RUNNER_BUILD_VERSION;
    } else {
      process.env.CODEX_RUNNER_BUILD_VERSION = ORIGINAL_BUILD_VERSION;
    }
  }
}

describe("build info version", () => {
  test("uses injected build version when provided", () => {
    withBuildVersion(" v9.9.9 ", () => {
      expect(resolveBuildVersion()).toBe("v9.9.9");
      expect(bunBuildInfo().version).toBe("v9.9.9");
      expect(formatBunVersion()).toContain("codex-issue-runner v9.9.9 ");
    });
  });

  test("falls back to git-derived version instead of old dev marker", () => {
    withBuildVersion(undefined, () => {
      const version = resolveBuildVersion();

      expect(version).not.toBe(OLD_DEV_VERSION);
      expect(version.length).toBeGreaterThan(0);
    });
  });
});
