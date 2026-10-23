import { describe, expect, test } from "bun:test";
import { piRuntimeCompactionSettings } from "./piRuntime.ts";

describe("PI runtime compaction policy", () => {
  test("starts compaction with enough headroom before the model context overflows", () => {
    expect(piRuntimeCompactionSettings({ contextWindow: 128_000 })).toEqual({
      enabled: true,
      keepRecentTokens: 19_200,
      reserveTokens: 51_200
    });
    expect(piRuntimeCompactionSettings({ contextWindow: 32_000 })).toEqual({
      enabled: true,
      keepRecentTokens: 4_800,
      reserveTokens: 12_800
    });
  });

  test("falls back to PI SDK defaults when model metadata has no context window", () => {
    expect(piRuntimeCompactionSettings(undefined)).toEqual({
      enabled: true,
      keepRecentTokens: 20_000,
      reserveTokens: 16_384
    });
  });
});
