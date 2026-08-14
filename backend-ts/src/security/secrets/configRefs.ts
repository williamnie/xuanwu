import type { RunnerLocalSettings } from "../../config/localSettings.ts";
import type { SecretService } from "./service.ts";
import { resolveSecretLocator } from "./service.ts";

const FEISHU_REFS = [
  ["appSecretRef", "appSecret"],
  ["encryptKeyRef", "encryptKey"],
  ["verificationTokenRef", "verificationToken"]
] as const;

export function resolveLocalSettingsSecretRefs(
  settings: RunnerLocalSettings,
  secrets: SecretService,
  env: Record<string, string | undefined> = Bun.env
): RunnerLocalSettings {
  const integrations = settings.integrations;
  const qoder = settings.providers?.qoder;
  return {
    ...settings,
    ...(integrations ? { integrations: {
      ...integrations,
      ...(integrations.feishu ? { feishu: resolveFeishu(integrations.feishu, secrets, env) } : {}),
      ...(integrations.github ? { github: resolveRemoteGit(integrations.github, secrets, env) } : {}),
      ...(integrations.gitlab ? { gitlab: resolveRemoteGit(integrations.gitlab, secrets, env) } : {})
    } } : {}),
    ...(qoder ? {
      providers: {
        ...settings.providers,
        qoder: resolveQoder(qoder, secrets, env)
      }
    } : {})
  };
}

function resolveQoder(
  value: NonNullable<NonNullable<RunnerLocalSettings["providers"]>["qoder"]>,
  secrets: SecretService,
  env: Record<string, string | undefined>
): NonNullable<NonNullable<RunnerLocalSettings["providers"]>["qoder"]> {
  const ref = stringValue(value.credentialRef);
  if (ref === "") return value;
  try {
    return { ...value, credential: resolveSecretLocator(secrets, ref, env) };
  } catch {
    return { ...value, credential: "" };
  }
}

function resolveFeishu(
  value: Record<string, unknown>,
  secrets: SecretService,
  env: Record<string, string | undefined>
): Record<string, unknown> {
  const resolved = { ...value };
  for (const [refKey, valueKey] of FEISHU_REFS) {
    const ref = stringValue(value[refKey]);
    if (ref !== "") resolved[valueKey] = resolveSecretLocator(secrets, ref, env);
  }
  return resolved;
}

function resolveRemoteGit(
  value: Record<string, unknown>,
  secrets: SecretService,
  env: Record<string, string | undefined>
): Record<string, unknown> {
  const ref = stringValue(value.tokenRef ?? value.token_ref);
  if (ref === "") return value;
  if (!ref.startsWith("secret://") && !ref.startsWith("env://")) return value;
  return { ...value, token: resolveSecretLocator(secrets, ref, env) };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
