import type { RunnerConfig } from "../../config/env.ts";
import type { SystemStatusContext, RuntimeStatus } from "./systemStatus.model.ts";
import { buildSystemStatus, doctorProvider } from "./systemStatus.buildSystemStatus.ts";
import { providerStatus } from "./systemStatus.claudeProviderEntry.ts";

export function buildRuntimeDoctor(context: SystemStatusContext): Record<string, unknown> {
  const status = buildSystemStatus(context) as RuntimeStatus;
  return {
    generated_at: new Date().toISOString(),
    service: status.service,
    listen: { addr: status.config.addr },
    auth: { enabled: status.auth.enabled, current_request_authorized: true },
    security: status.security,
    health: status.health,
    db: { ...status.db, path: status.config.db_path, path_visible: status.db.ok },
    runner: status.runner,
    projects: [],
    providers: status.providers.map(doctorProvider),
    connectors: status.connectors,
    observability: status.observability,
    process_group_memory: status.process_group_memory,
    recent_errors: { count: 0, sources: [] }
  };
}

/** Resolve slow provider CLI versions before the HTTP listener is exposed. */
export function primeProviderStatus(config: RunnerConfig): void {
  providerStatus(config);
}
