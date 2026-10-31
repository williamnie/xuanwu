import { DEFAULT_ADDR, buildRunnerPaths } from "./paths.ts";
import { readLocalSettingsSync } from "./localSettings.ts";
import { buildFeishuConnectorConfig } from "../integrations/feishu/feishu.ts";
import { buildTelegramConnectorConfig } from "../integrations/telegram/telegramConfig.ts";
import { buildGitHubConnectorConfig } from "../integrations/github/config.ts";
import { buildGitLabConnectorConfig } from "../integrations/gitlab/config.ts";
import { resolveLocalSettingsSecretRefs } from "../security/secrets/configRefs.ts";
import { createSecretService, resolveSecretLocator } from "../security/secrets/service.ts";
import type { Env, RunnerConfig, ConfigOverrides } from "./env.types.ts";
import { readEnvOverrides, parseCliOverrides, stripCommand } from "./env.input.ts";
import { buildCodexServerConfig, buildCodexRuntimeConfig, buildPiRuntimeConfig, buildQoderRuntimeConfig } from "./env.providers.ts";
import { cleanValue } from "./env.values.ts";
import { buildCliConnectorConfig, effectiveFeishuInput, effectiveTelegramInput, effectiveGitHubInput, effectiveGitLabInput } from "./env.integrations.ts";
import { buildClaudeRuntimeConfig } from "./env.claude.ts";
import { buildRunnerConcurrencyConfig } from "./env.concurrency.ts";

export function loadConfig(argv = Bun.argv.slice(2), env: Env = Bun.env): RunnerConfig {
  const envOverrides = readEnvOverrides(env);
  const cliOverrides = parseCliOverrides(stripCommand(argv));
  const baseOverrides = { ...envOverrides, ...cliOverrides };
  const stateDir = buildRunnerPaths(baseOverrides).stateDir;
  const secretService = createSecretService({ stateDir });
  const localOverrides = resolveLocalSettingsSecretRefs(
    readLocalSettingsSync(stateDir),
    secretService,
    env
  );
  const localCodex = localOverrides.providers?.codex ?? {};
  const localClaude = localOverrides.providers?.claude ?? {};
  const localPi = localOverrides.providers?.["pi-coding-agent"] ?? {};
  const localQoder = localOverrides.providers?.qoder ?? {};
  const qoderAuthMode = localQoder.authMode ?? baseOverrides.qoderAuthMode;
  const qoderCredentialRef = localQoder.credentialRef ?? baseOverrides.qoderCredentialRef;
  const qoderCredential = localQoder.credential ?? (
    isQoderSecretRefMode(qoderAuthMode) && qoderCredentialRef
      ? resolveQoderCredential(secretService, qoderCredentialRef, env)
      : undefined
  );
  return buildConfig({
    ...baseOverrides,
    codexServerMode: localCodex.serverMode ?? baseOverrides.codexServerMode,
    codexCommand: localCodex.cliCommand ?? baseOverrides.codexCommand,
    codexAppCommand: localCodex.appCommand ?? baseOverrides.codexAppCommand,
    codexEnabled: localCodex.enabled ?? baseOverrides.codexEnabled,
    claudeEnabled: localClaude.enabled ?? baseOverrides.claudeEnabled,
    piCommand: localPi.command ?? baseOverrides.piCommand,
    piCwd: localPi.cwd ?? baseOverrides.piCwd,
    piEnabled: localPi.enabled ?? baseOverrides.piEnabled,
    piTimeoutMs: localPi.timeoutMs ?? baseOverrides.piTimeoutMs,
    qoderCommand: localQoder.command ?? baseOverrides.qoderCommand,
    qoderConfigDir: localQoder.configDir ?? baseOverrides.qoderConfigDir,
    qoderAuthMode,
    qoderCredential,
    qoderCredentialRef,
    qoderEnabled: localQoder.enabled ?? baseOverrides.qoderEnabled,
    qoderModel: localQoder.model ?? baseOverrides.qoderModel,
    qoderTimeoutMs: localQoder.timeoutMs ?? baseOverrides.qoderTimeoutMs,
    runner: { maxParallelProjects: localOverrides.runner?.maxParallelProjects ?? baseOverrides.runnerMaxParallelProjects },
    integrations: {
      feishu: localOverrides.integrations?.feishu ?? {},
      telegram: localOverrides.integrations?.telegram ?? {},
      github: localOverrides.integrations?.github ?? {},
      gitlab: localOverrides.integrations?.gitlab ?? {}
    }
  });
}

export function isQoderSecretRefMode(value: string | undefined): boolean {
  return value === "pat-secret-ref" || value === "service-account-secret-ref";
}

export function resolveQoderCredential(
  secrets: ReturnType<typeof createSecretService>,
  ref: string,
  env: Env
): string {
  try {
    return resolveSecretLocator(secrets, ref, env);
  } catch {
    return "";
  }
}

export function buildConfig(overrides: ConfigOverrides = {}): RunnerConfig {
  const paths = buildRunnerPaths(overrides);
  const codexServer = buildCodexServerConfig(overrides);
  return {
    addr: cleanValue(overrides.addr) ?? DEFAULT_ADDR,
    agenticAddr: cleanValue(overrides.agenticAddr) ?? "127.0.0.1:3010",
    authToken: cleanValue(overrides.authToken) ?? "",
    codexSessionsDir: cleanValue(overrides.codexSessionsDir) ?? defaultCodexSessionsDir(),
    webDir: cleanValue(overrides.webDir) ?? "",
    ...paths,
    codexServer,
    cliConnectors: buildCliConnectorConfig(overrides),
    providers: {
      codex: buildCodexRuntimeConfig(overrides, codexServer),
      claude: buildClaudeRuntimeConfig(overrides),
      "pi-coding-agent": buildPiRuntimeConfig(overrides),
      qoder: buildQoderRuntimeConfig(overrides)
    },
    runner: buildRunnerConcurrencyConfig(overrides.runner ?? {
      maxParallelProjects: overrides.runnerMaxParallelProjects
    }),
    integrations: {
      feishu: buildFeishuConnectorConfig(effectiveFeishuInput(overrides)),
      telegram: buildTelegramConnectorConfig(effectiveTelegramInput(overrides)),
      github: buildGitHubConnectorConfig(effectiveGitHubInput(overrides)),
      gitlab: buildGitLabConnectorConfig(effectiveGitLabInput(overrides))
    }
  };
}

export function defaultCodexSessionsDir(): string {
  const home = cleanValue(Bun.env.HOME);
  return home ? `${home}/.codex/sessions` : "";
}
