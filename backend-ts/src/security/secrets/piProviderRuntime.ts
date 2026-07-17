import { readFileSync } from "node:fs";
import { createSecretService } from "./service.ts";

export function installPiProviderSecretOverride(
  authStorage: { setRuntimeApiKey(provider: string, apiKey: string): void },
  modelsPath: string,
  stateDir: string,
  provider: string
): void {
  const ref = providerSecretRef(modelsPath, provider);
  if (ref === "") return;
  authStorage.setRuntimeApiKey(provider, createSecretService({ stateDir }).resolve(ref));
}

function providerSecretRef(path: string, provider: string): string {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { providers?: Record<string, { apiKeyRef?: unknown }> };
    const ref = raw.providers?.[provider]?.apiKeyRef;
    return typeof ref === "string" ? ref.trim() : "";
  } catch {
    return "";
  }
}
