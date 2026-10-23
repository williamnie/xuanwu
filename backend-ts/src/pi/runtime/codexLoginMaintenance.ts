import type { RunnerConfig } from "../../config/env.ts";
import { effectiveCodexHome } from "../../config/codexServer.ts";
import type { RunnerDatabase } from "../../db/database.ts";
import type { ProviderRegistry } from "../../providers/core/registry.ts";
import type { CodexExecutorProvider } from "../../providers/codex/provider.ts";
import { asProviderId } from "../../providers/types.ts";
import { CODEX_REFRESH_INTERVAL_MS, createCodexLoginService } from "./codexLoginCredentials.ts";
import { registerCodexLoginService, selectedCredentialSource } from "./piModelRuntime.ts";

export function startCodexLoginMaintenance(db: RunnerDatabase, config: RunnerConfig, registry?: ProviderRegistry,
  schedule = (check: () => void) => { const timer = setInterval(check, CODEX_REFRESH_INTERVAL_MS); timer.unref(); return () => clearInterval(timer); }
) {
  const workerKey = {};
  const service = createCodexLoginService({
    role: registry ? "core" : "worker",
    binding: () => {
      const providerConfig = config.providers.codex;
      const home = effectiveCodexHome(providerConfig);
      const base = { home, managedHome: home, key: workerKey };
      if (!providerConfig || providerConfig.enabled === false) return { ...base, unavailable: "codex_provider_disabled" };
      if (!registry) return base;
      try {
        const entry = registry.describe(asProviderId("codex"));
        const provider = entry.instance as CodexExecutorProvider | undefined;
        if (entry.state !== "ready" || !provider) return { ...base, unavailable: "codex_provider_unavailable" };
        if (!provider.refreshCodexLogin || !provider.codexCredentialHome) return { ...base, unavailable: "codex_account_unavailable" };
        return { home, managedHome: provider.codexCredentialHome, key: provider,
          refresh: () => provider.refreshCodexLogin() };
      } catch { return { ...base, unavailable: "codex_provider_unavailable" }; }
    }
  });
  const unregister = registerCodexLoginService(db, service);
  const check = async () => {
    if (selectedCredentialSource(db) !== "codex_login") return;
    try { await service.maintain(); } catch { /* Status exposes only the classified error, never the provider payload. */ }
  };
  const stopTimer = registry ? schedule(() => void check()) : undefined;
  // Also cover an already-expired login after core downtime. No writes or network for stored users.
  if (registry) void check();
  return () => { stopTimer?.(); unregister(); };
}
