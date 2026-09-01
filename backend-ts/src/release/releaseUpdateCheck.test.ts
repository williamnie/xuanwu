import { describe, expect, test } from "bun:test";
import { isNewerRelease, releaseUpdateCheckForCurrent } from "./releaseUpdateCheck.ts";

describe("release update version authority", () => {
  test("uses the running Core build instead of an unrelated updater-path binary", () => {
    expect(releaseUpdateCheckForCurrent({
      current: "v0.2.0",
      latest: "v0.2.6",
      update_available: true
    }, "v0.2.5")).toEqual({ current: "v0.2.5", latest: "v0.2.6", update_available: true });
  });

  test("compares stable and prerelease versions with SemVer precedence", () => {
    expect(isNewerRelease("v1.2.3", "v1.2.4")).toBe(true);
    expect(isNewerRelease("v1.2.3-rc.9", "v1.2.3-rc.10")).toBe(true);
    expect(isNewerRelease("v1.2.3-rc.1", "v1.2.3")).toBe(true);
    expect(isNewerRelease("v1.2.3", "v1.2.3-rc.1")).toBe(false);
    expect(isNewerRelease("v1.2.3", "v1.2.3")).toBe(false);
  });
});
