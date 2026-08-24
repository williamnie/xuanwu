import { describe, expect, test } from "bun:test";
import { resolvePiChatToolMode } from "./runtimePromptProfile.ts";

describe("PI runtime prompt profile", () => {
  test("uses the registry bootstrap surface by default", () => {
    expect(resolvePiChatToolMode(false, {})).toBe("full");
    expect(resolvePiChatToolMode(false, { XUANWU_PI_CHAT_TOOL_SURFACE: "bootstrap_v2" })).toBe("full");
  });

  test("supports an emergency rollback to the legacy full chat surface", () => {
    expect(resolvePiChatToolMode(false, { XUANWU_PI_CHAT_TOOL_SURFACE: " legacy_full " }))
      .toBe("legacy_full");
    expect(resolvePiChatToolMode(true, { XUANWU_PI_CHAT_TOOL_SURFACE: "legacy_full" })).toBe("review");
  });
});
