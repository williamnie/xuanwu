import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ENV_KEYS, loadConfig } from "./env.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { tempStateDir } from "./envTestFixtures.ts";

export function registerEnvArgumentsCases() {
  test("loads Codex server selection from local settings", async () => {
    const stateDir = await tempStateDir();
    await writeFile(join(stateDir, "runner-settings.local.json"), JSON.stringify({
      providers: {
        codex: {
          appCommand: "/Applications/Codex.app/Contents/Resources/codex",
          cliCommand: "local-codex",
          serverMode: "app"
        }
      }
    }), "utf8");

    const config = loadConfig([], {
      [ENV_KEYS.stateDir]: stateDir,
      [ENV_KEYS.codexCommand]: "env-codex"
    });

    expect(config.codexServer).toMatchObject({
      appCommand: "/Applications/Codex.app/Contents/Resources/codex app-server --listen stdio://",
      cliCommand: "local-codex app-server --listen stdio://",
      mode: "app"
    });
    expect(config.providers.codex).toMatchObject({
      command: "/Applications/Codex.app/Contents/Resources/codex app-server --listen stdio://",
      env: expect.objectContaining({ BROWSER_USE_AVAILABLE_BACKENDS: "chrome,iab" })
    });
  });

  test("loads persisted Code Agent enablement for Codex, Claude and Pi", async () => {
    const stateDir = await tempStateDir();
    await writeFile(join(stateDir, "runner-settings.local.json"), JSON.stringify({
      providers: {
        codex: { enabled: false },
        claude: { enabled: false },
        "pi-coding-agent": { enabled: false }
      }
    }), "utf8");

    const config = loadConfig([], { [ENV_KEYS.stateDir]: stateDir });
    expect(config.providers.codex?.enabled).toBe(false);
    expect(config.providers.claude?.enabled).toBe(false);
    expect(config.providers["pi-coding-agent"]?.enabled).toBe(false);
  });

  test("loads Pi runtime settings from local settings", async () => {
    const stateDir = await tempStateDir();
    await writeFile(join(stateDir, "runner-settings.local.json"), JSON.stringify({
      providers: {
        pi: {
          command: "local-pi --offline",
          cwd: "/tmp/local-pi-project",
          enabled: false,
          timeoutMs: 9876
        }
      }
    }), "utf8");

    const config = loadConfig([], { [ENV_KEYS.stateDir]: stateDir });

    expect(config.providers["pi-coding-agent"]).toEqual({
      command: "local-pi --offline",
      cwd: "/tmp/local-pi-project",
      enabled: false,
      env: {},
      timeoutMs: 9876
    });
  });

  test("loads Qoder local settings over CLI flags and environment without persisting credentials", async () => {
    const stateDir = await tempStateDir();
    await writeFile(join(stateDir, "runner-settings.local.json"), JSON.stringify({
      providers: {
        qoder: {
          authMode: "service-account-secret-ref",
          command: "/local/xuanwu.qodercli",
          configDir: "/local/qoder-config",
          credentialRef: "env://QODER_TEST_SERVICE_ACCOUNT",
          enabled: false,
          model: "local-model",
          timeoutMs: 9876
        }
      }
    }), "utf8");

    const config = loadConfig([
      "--qoder-auth-mode", "pat-secret-ref",
      "--qoder-cmd", "/flag/xuanwu.qodercli",
      "--qoder-config-dir", "/flag/qoder-config",
      "--qoder-credential-ref", "env://QODER_FLAG_PAT",
      "--qoder-enabled", "true",
      "--qoder-model", "flag-model",
      "--qoder-timeout-ms", "8765"
    ], {
      [ENV_KEYS.stateDir]: stateDir,
      [ENV_KEYS.qoderCommand]: "/env/xuanwu.qodercli",
      [ENV_KEYS.qoderAuthMode]: "pat-env",
      QODER_PERSONAL_ACCESS_TOKEN: "env-pat-secret",
      QODER_TEST_SERVICE_ACCOUNT: "local-service-account-secret",
      QODER_FLAG_PAT: "flag-pat-secret"
    });

    expect(config.providers.qoder).toEqual({
      authMode: "service-account-secret-ref",
      command: "/local/xuanwu.qodercli",
      configDir: "/local/qoder-config",
      credential: "local-service-account-secret",
      credentialRef: "env://QODER_TEST_SERVICE_ACCOUNT",
      cwd: "",
      enabled: false,
      env: {},
      mode: "sdk",
      model: "local-model",
      timeoutMs: 9876
    });
    const persisted = await readFile(join(stateDir, "runner-settings.local.json"), "utf8");
    expect(persisted).not.toContain("local-service-account-secret");
    expect(redactSensitiveText("local-service-account-secret env-pat-secret")).toBe("[redacted] [redacted]");
  });

  test("lets Qoder CLI flags override environment and keeps PAT out of argv", () => {
    const config = loadConfig([
      "--qoder-auth-mode", "pat-env",
      "--qoder-cmd", "/flag/xuanwu.qodercli",
      "--qoder-config-dir", "/flag/qoder-config",
      "--qoder-model", "flag-model",
      "--qoder-timeout-ms", "7654"
    ], {
      [ENV_KEYS.qoderCommand]: "/env/xuanwu.qodercli",
      [ENV_KEYS.qoderConfigDir]: "/env/qoder-config",
      [ENV_KEYS.qoderModel]: "env-model",
      [ENV_KEYS.qoderTimeoutMs]: "6543",
      QODER_PERSONAL_ACCESS_TOKEN: "qoder-pat-secret"
    });

    expect(config.providers.qoder).toMatchObject({
      authMode: "pat-env",
      command: "/flag/xuanwu.qodercli",
      configDir: "/flag/qoder-config",
      env: { QODER_PERSONAL_ACCESS_TOKEN: "qoder-pat-secret" },
      model: "flag-model",
      timeoutMs: 7654
    });
    expect(() => loadConfig(["--qoder-pat", "must-not-appear-in-process-args"], {})).toThrow("Unknown config argument");
  });

  test("selects Codex App server mode from environment", () => {
    const config = loadConfig([], {
      [ENV_KEYS.codexServerMode]: "app",
      [ENV_KEYS.codexAppCommand]: "/opt/Codex.app/Contents/Resources/codex",
      [ENV_KEYS.codexEnv]: "SAFE_VALUE=ok"
    });

    expect(config.codexServer).toMatchObject({
      appCommand: "/opt/Codex.app/Contents/Resources/codex app-server --listen stdio://",
      mode: "app"
    });
    expect(config.providers.codex).toMatchObject({
      command: "/opt/Codex.app/Contents/Resources/codex app-server --listen stdio://",
      env: expect.objectContaining({
        BROWSER_USE_AVAILABLE_BACKENDS: "chrome,iab",
        SAFE_VALUE: "ok"
      })
    });
  });
}
