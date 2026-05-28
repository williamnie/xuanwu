import { describe, expect, test } from "bun:test";
import { ENV_KEYS, buildConfig, loadConfig } from "./env.ts";

describe("Bun backend config", () => {
  test("uses Bun preview defaults", () => {
    expect(buildConfig()).toEqual({
      addr: "127.0.0.1:3018",
      stateDir: "data-bun",
      dbPath: "data-bun/runner.db",
      authToken: "",
      authTokenFile: "data-bun/auth_token"
    });
  });

  test("derives db and auth token paths from overridden state dir", () => {
    expect(buildConfig({ stateDir: "/tmp/codex-bun" })).toEqual({
      addr: "127.0.0.1:3018",
      stateDir: "/tmp/codex-bun",
      dbPath: "/tmp/codex-bun/runner.db",
      authToken: "",
      authTokenFile: "/tmp/codex-bun/auth_token"
    });
  });

  test("reads Bun-specific environment overrides including auth token", () => {
    const config = loadConfig([], {
      [ENV_KEYS.addr]: "127.0.0.1:3999",
      [ENV_KEYS.stateDir]: "/tmp/state-bun",
      [ENV_KEYS.dbPath]: "/tmp/runner-bun.db",
      [ENV_KEYS.authToken]: "env-token",
      [ENV_KEYS.authTokenFile]: "/tmp/token-bun"
    });

    expect(config).toEqual({
      addr: "127.0.0.1:3999",
      stateDir: "/tmp/state-bun",
      dbPath: "/tmp/runner-bun.db",
      authToken: "env-token",
      authTokenFile: "/tmp/token-bun"
    });
  });

  test("lets CLI flags override environment", () => {
    const env = { [ENV_KEYS.addr]: "127.0.0.1:3999", [ENV_KEYS.authToken]: "env-token" };
    const config = loadConfig([
      "serve",
      "--addr", "127.0.0.1:4018",
      "--state-dir=/tmp/cli-state",
      "--db", "/tmp/cli.db",
      "--auth-token", "cli-token",
      "--auth-token-file", "/tmp/cli-token"
    ], env);

    expect(config).toEqual({
      addr: "127.0.0.1:4018",
      stateDir: "/tmp/cli-state",
      dbPath: "/tmp/cli.db",
      authToken: "cli-token",
      authTokenFile: "/tmp/cli-token"
    });
  });
});
