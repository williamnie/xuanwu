import { describe, expect, test } from "bun:test";
import { ENV_KEYS, buildConfig, loadConfig } from "./env.ts";

describe("Bun backend config", () => {
  test("uses Bun preview defaults", () => {
    expect(buildConfig()).toEqual({
      addr: "127.0.0.1:3018",
      stateDir: "data-bun",
      dbPath: "data-bun/runner.db",
      authToken: "",
      authTokenFile: "data-bun/auth_token",
      providers: {
        codex: { command: "codex app-server --listen stdio://", cwd: "", env: {}, timeoutMs: 1_800_000 }
      }
    });
  });

  test("derives db and auth token paths from overridden state dir", () => {
    expect(buildConfig({ stateDir: "/tmp/codex-bun" })).toMatchObject({
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
      [ENV_KEYS.authTokenFile]: "/tmp/token-bun",
      [ENV_KEYS.codexCommand]: "/opt/bin/codex app-server --listen stdio://",
      [ENV_KEYS.codexCwd]: "/tmp/project",
      [ENV_KEYS.codexEnv]: "CODEX_HOME=/tmp/codex, SAFE_VALUE=ok, CODEX_API_KEY=secret",
      [ENV_KEYS.codexTimeoutMs]: "1234"
    });

    expect(config).toEqual({
      addr: "127.0.0.1:3999",
      stateDir: "/tmp/state-bun",
      dbPath: "/tmp/runner-bun.db",
      authToken: "env-token",
      authTokenFile: "/tmp/token-bun",
      providers: {
        codex: {
          command: "/opt/bin/codex app-server --listen stdio://",
          cwd: "/tmp/project",
          env: { CODEX_HOME: "/tmp/codex", SAFE_VALUE: "ok", CODEX_API_KEY: "secret" },
          timeoutMs: 1234
        }
      }
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
      "--auth-token-file", "/tmp/cli-token",
      "--codex-cmd", "cli-codex app-server --listen stdio://",
      "--codex-cwd=/tmp/cli-project",
      "--codex-env", "CODEX_HOME=/tmp/cli-codex",
      "--codex-timeout-ms", "5678"
    ], env);

    expect(config).toEqual({
      addr: "127.0.0.1:4018",
      stateDir: "/tmp/cli-state",
      dbPath: "/tmp/cli.db",
      authToken: "cli-token",
      authTokenFile: "/tmp/cli-token",
      providers: {
        codex: {
          command: "cli-codex app-server --listen stdio://",
          cwd: "/tmp/cli-project",
          env: { CODEX_HOME: "/tmp/cli-codex" },
          timeoutMs: 5678
        }
      }
    });
  });
});
