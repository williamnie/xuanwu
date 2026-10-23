import { describe, expect, test } from "bun:test";
import { correctedRuntimeRawRef, runtimeRawRef } from "./sessionRuntimeSettings.ts";

describe("provider-scoped session runtime settings", () => {
  test("persists the provider that owns model and tier settings", () => {
    expect(runtimeRawRef({ cwd: "/tmp", model: "claude-sonnet", serviceTier: "fast" }, "turn-1", "claude")).toEqual({
      model: "claude-sonnet",
      service_tier: "fast",
      settings_provider: "claude",
      provider_turn_id: "turn-1"
    });
  });

  test("drops foreign provider settings and applies authoritative adapter metadata", () => {
    expect(correctedRuntimeRawRef(JSON.stringify({
      model: "deepseek/deepseek-v4-flash",
      reasoning_effort: "high",
      service_tier: "priority",
      settings_provider: "pi-coding-agent",
      approval_policy: "never"
    }), "claude", { model: "claude-sonnet-4-5" })).toEqual({
      model: "claude-sonnet-4-5",
      settings_provider: "claude",
      approval_policy: "never"
    });
  });

  test("removes the known legacy Codex default even when an adapter has no model metadata", () => {
    expect(correctedRuntimeRawRef(
      JSON.stringify({ model: "codex-default", approval_policy: "never" }),
      "claude",
      {}
    )).toEqual({ approval_policy: "never", settings_provider: "claude" });
  });
});
