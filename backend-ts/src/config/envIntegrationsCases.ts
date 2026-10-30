import { expect, test } from "bun:test";

import { ENV_KEYS, buildConfig, loadConfig } from "./env.ts";

export function registerEnvIntegrationsCases() {
  test("maps an Anthropic platform OAuth profile without allowing environment credentials to override it", () => {
    const config = loadConfig([], {
      [ENV_KEYS.claudeAuthMode]: "platform-profile",
      [ENV_KEYS.claudePlatformConfigDir]: "/tmp/anthropic-profile",
      [ENV_KEYS.claudePlatformProfile]: "runner",
      [ENV_KEYS.claudeApiKey]: "must-not-win",
      ANTHROPIC_AUTH_TOKEN: "must-not-win-either"
    });

    expect(config.providers.claude).toMatchObject({
      authMode: "platform-profile",
      env: {
        ANTHROPIC_CONFIG_DIR: "/tmp/anthropic-profile",
        ANTHROPIC_PROFILE: "runner"
      },
      mode: "sdk",
      platformConfigDir: "/tmp/anthropic-profile",
      platformProfile: "runner"
    });
    expect(config.providers.claude?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(config.providers.claude?.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  });

  test("defaults SDK and explicit CLI fallback to local login and rejects incompatible profile auth", () => {
    expect(buildConfig().providers.claude).toMatchObject({
      authMode: "local-cli",
      mode: "sdk"
    });
    expect(buildConfig({ claudeMode: "cli-fallback" }).providers.claude).toMatchObject({
      authMode: "local-cli",
      mode: "cli-fallback"
    });
    expect(buildConfig({ claudeMode: "cli-fallback", claudeEnv: "ANTHROPIC_API_KEY=key" }).providers.claude).toMatchObject({
      authMode: "environment",
      mode: "cli-fallback"
    });
    expect(buildConfig({ claudeMode: "sdk", claudeAuthMode: "local-cli" }).providers.claude).toMatchObject({
      authMode: "local-cli",
      mode: "sdk"
    });
    expect(() => buildConfig({ claudeMode: "cli-fallback", claudeAuthMode: "platform-profile" })).toThrow("requires XUANWU_CLAUDE_MODE=sdk");
    expect(() => buildConfig({ claudeAuthMode: "platform-profile", claudePlatformProfile: "../unsafe" })).toThrow("PLATFORM_PROFILE");
  });

  test("keeps Claude CLI as an explicit fallback and rejects unsafe API bases", () => {
    expect(buildConfig({ claudeMode: "cli-fallback" }).providers.claude?.mode).toBe("cli-fallback");
    expect(buildConfig({ claudeApiBaseUrl: "https://gateway.example" }).providers.claude).toMatchObject({
      authMode: "local-cli",
      mode: "sdk"
    });
    expect(() => buildConfig({ claudeApiBaseUrl: "file:///tmp/proxy" })).toThrow("must be an http(s) URL");
  });
}
