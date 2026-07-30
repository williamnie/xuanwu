import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import { claudeAuthenticationStatus, claudeProcessEnvironment } from "./auth.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { force: true, recursive: true });
});

describe("Claude authentication resolution", () => {
  test("accepts a private Anthropic user OAuth profile without reading credentials into status", async () => {
    const root = await profileFixture("runner", 0o600);
    const status = claudeAuthenticationStatus(config({
      authMode: "platform-profile",
      env: { ANTHROPIC_CONFIG_DIR: root, ANTHROPIC_PROFILE: "runner" },
      platformConfigDir: root,
      platformProfile: "runner"
    }));

    expect(status).toMatchObject({
      configured: true,
      mode: "platform-profile",
      source: "platform_profile",
      platform_profile: {
        auth_type: "user_oauth",
        credentials_file_ready: true,
        profile: "runner"
      }
    });
    expect(JSON.stringify(status)).not.toContain("refresh-secret");
  });

  test("fails closed when an OAuth profile credentials file is missing or broadly readable", async () => {
    const missing = await profileFixture("missing", undefined);
    expect(claudeAuthenticationStatus(config({
      authMode: "platform-profile",
      platformConfigDir: missing,
      platformProfile: "missing"
    }))).toMatchObject({ configured: false, reason: expect.stringContaining("missing or not private") });

    if (process.platform !== "win32") {
      const unsafe = await profileFixture("unsafe", 0o644);
      expect(claudeAuthenticationStatus(config({
        authMode: "platform-profile",
        platformConfigDir: unsafe,
        platformProfile: "unsafe"
      }))).toMatchObject({ configured: false, reason: expect.stringContaining("missing or not private") });
    }
  });

  test("removes higher-precedence environment credentials for profile and local CLI modes", () => {
    const parent = {
      ANTHROPIC_API_KEY: "parent-secret",
      ANTHROPIC_AUTH_TOKEN: "parent-auth-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "parent-oauth-secret",
      HOME: "/tmp/home"
    };
    for (const authMode of ["platform-profile", "local-cli"] as const) {
      const environment = claudeProcessEnvironment(config({
        authMode,
        env: { ANTHROPIC_API_KEY: "configured-secret", SAFE_VALUE: "kept" }
      }), parent);
      expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
      expect(environment.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(environment.HOME).toBe("/tmp/home");
      expect(environment.SAFE_VALUE).toBe("kept");
    }
  });
});

function config(overrides: Partial<ProviderRuntimeConfig> = {}): ProviderRuntimeConfig {
  return {
    command: "claude",
    cwd: "",
    env: {},
    mode: "sdk",
    timeoutMs: 5_000,
    ...overrides
  };
}

async function profileFixture(profile: string, credentialMode: number | undefined): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-anthropic-profile-"));
  roots.push(root);
  await mkdir(join(root, "configs"), { recursive: true });
  await mkdir(join(root, "credentials"), { recursive: true });
  await writeFile(join(root, "configs", `${profile}.json`), JSON.stringify({
    version: "1.0",
    authentication: { type: "user_oauth" }
  }));
  if (credentialMode !== undefined) {
    const credentials = join(root, "credentials", `${profile}.json`);
    await writeFile(credentials, JSON.stringify({ refresh_token: "refresh-secret", version: "1.0" }));
    await chmod(credentials, credentialMode);
  }
  return root;
}
