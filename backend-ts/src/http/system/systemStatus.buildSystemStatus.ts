import { buildStaticConnectorDiagnostics } from "../../integrations/connectorDiagnostics.ts";
import type { RunnerDatabase } from "../../db/database.ts";
import { projectLoopMaxParallelProjects, runningProjectLoopCount } from "../../runner/projectLoopManager.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { eventProjectionStatusForRead } from "../../db/repositories/compactEventSummaryProjection.ts";
import { runProgressProjectionStatus } from "../../db/repositories/runProgress.ts";
import { buildRuntimeObservability } from "../../observability/runtimeObservability.ts";
import { PROCESS_GROUP_MEMORY_CONTRACT } from "../../observability/processGroupMemory.ts";
import { objectValue } from "../../util/values.ts";
import type { SystemStatusContext, ProviderStatus, CheckStatus } from "./systemStatus.model.ts";
import { roundedMs } from "./systemStatus.providerEntry.ts";
import { providerStatus, serviceStatus, databaseStatus, configStatus, securityWarnings, codexStatus, connectorStatus } from "./systemStatus.claudeProviderEntry.ts";

export function buildSystemStatus(context: SystemStatusContext): Record<string, unknown> {
  const startedAt = performance.now();
  const timings: Record<string, number> = {};
  const phase = <T>(name: string, operation: () => T): T => {
    const started = performance.now();
    try {
      return operation();
    } finally {
      timings[name] = roundedMs(performance.now() - started);
    }
  };
  const providers = phase("providers", () => providerStatus(context.config, context.providersRegistry));
  const receiver = phase("receiver", () => context.feishuReceiverStatus?.());
  const connectorHealth = phase("connector_health", () => buildStaticConnectorDiagnostics({
    config: context.config,
    database: context.database,
    feishuReceiverStatus: receiver,
    webhookSigningSecret: context.webhookSigningSecret
  }));
  const eventProjection = phase("event_projection", () => eventProjectionStatusForRead(context.database));
  const runProgressProjection = phase("run_progress_projection", () => runProgressProjectionStatus(context.database));
  const observability = phase("observability", () => buildRuntimeObservability(context.database));
  const status = {
    service: phase("service", () => serviceStatus(context.startedAt, context.role)),
    db: phase("database", () => databaseStatus(context.database)),
    auth: { enabled: context.authEnabled },
    config: configStatus(context),
    security: { warnings: securityWarnings(context.config.addr, context.authEnabled) },
    codex: phase("codex", () => codexStatus(context.config)),
    providers,
    connectors: phase("connectors", () => connectorStatus(context.config, receiver)),
    connector_health: connectorHealth,
    event_projection: eventProjection,
    run_progress_projection: runProgressProjection,
    runner: phase("runner", () => runnerStatus(context.database)),
    observability,
    process_group_memory: phase("process_group_memory", () => (
      context.processGroupMemory?.snapshot() ?? unavailableProcessGroupMemory()
    )),
    background_projection: context.projectionWorker?.snapshot() ?? { status: "unavailable" }
  };
  const health = phase("health", () => systemHealth({
    ...status,
    required_provider_ids: requiredProviderIDs(context.database)
  }));
  const durationMs = performance.now() - startedAt;
  if (durationMs >= 500) {
    console.warn(JSON.stringify({
      event: "runner.system_status_slow",
      duration_ms: roundedMs(durationMs),
      phases_ms: timings
    }));
  }
  return { ...status, health };
}

/** Lightweight authenticated liveness payload for the Web shell. */
export function buildCompactSystemStatus(context: SystemStatusContext): Record<string, unknown> {
  const command = redactSensitiveText(context.config.providers.codex?.command ?? "");
  return {
    service: serviceStatus(context.startedAt, context.role),
    db: databaseStatus(context.database),
    auth: { enabled: context.authEnabled },
    config: configStatus(context),
    codex: { command, command_ok: command.trim() !== "" },
    providers: providerStatus(context.config, context.providersRegistry),
    runner: runnerStatus(context.database)
  };
}

export function runnerStatus(database: RunnerDatabase): Record<string, number> {
  return {
    auto_run_projects: countRows(database, "select count(*) as count from projects where auto_run=1"),
    running_loops: runningProjectLoopCount(),
    max_parallel_projects: projectLoopMaxParallelProjects(),
    held_projects: countRows(database, "select count(*) as count from project_holds"),
    in_progress_issues: countRows(database, "select count(*) as count from issues where status='in_progress'"),
    running_issues: countRows(database, "select count(*) as count from issue_runs where ended_at=''"),
    running_sessions: countRows(database, "select count(*) as count from agent_sessions where status in ('running','inProgress')")
  };
}

export function countRows(database: RunnerDatabase, sql: string): number {
  return database.sqlite.query<{ count: number }, []>(sql).get()?.count ?? 0;
}

export function doctorProvider(provider: ProviderStatus): Record<string, unknown> {
  return {
    id: provider.id,
    label: provider.label,
    status: provider.status,
    available: provider.available,
    enabled: provider.enabled,
    capabilities: provider.capabilities
  };
}

export function systemHealth(status: {
  connector_health: Array<Record<string, unknown>>;
  db: CheckStatus;
  event_projection: Record<string, unknown>;
  observability: Record<string, unknown>;
  process_group_memory: Record<string, unknown>;
  providers: ProviderStatus[];
  required_provider_ids: Set<string>;
  run_progress_projection: Record<string, unknown>;
  security: { warnings: Array<Record<string, string>> };
}): Record<string, unknown> {
  const reasons: Array<Record<string, unknown>> = [];
  if (!status.db.ok) reasons.push(healthReason("database_unavailable", "critical", "db", "database query failed"));
  for (const warning of arrayObjects(status.security.warnings)) {
    reasons.push(healthReason(String(warning.code || "security_warning"), "warning", "security", String(warning.message || "security warning")));
  }
  for (const provider of status.providers.filter((item) => status.required_provider_ids.has(item.id) && !item.available)) {
    reasons.push(healthReason("provider_unavailable", "warning", `provider:${provider.id}`, `${provider.label} is unavailable`));
  }
  for (const connector of status.connector_health) {
    const health = objectValue(connector.health);
    const state = String(health.state ?? connector.state ?? "");
    if (["failed", "degraded", "disconnected", "rate_limited", "revoked"].includes(state)) {
      reasons.push(healthReason(
        "connector_unhealthy",
        state === "failed" || state === "revoked" ? "critical" : "warning",
        `connector:${String(connector.id ?? "unknown")}`,
        state
      ));
    }
  }
  if (status.event_projection.status === "lagging") {
    reasons.push(healthReason("event_projection_lagging", "warning", "event_summary_projection", `${Number(status.event_projection.lag_rows ?? 0)} rows pending`));
  }
  if (Number(status.run_progress_projection.stalled_runs ?? 0) > 0) {
    reasons.push(healthReason("run_progress_stalled", "warning", "run_progress_projection", `${Number(status.run_progress_projection.stalled_runs)} runs stalled`));
  }
  const healthSignals = objectValue(status.observability.health_signals);
  for (const signal of arrayObjects(healthSignals.reasons)) {
    reasons.push(healthReason(String(signal.code ?? "observability_degraded"), "warning", String(signal.source_ref ?? "observability"), `${Number(signal.count ?? 0)} affected`));
  }
  const memoryBudget = objectValue(status.process_group_memory.budget);
  if (memoryBudget.status === "hard_exceeded" || memoryBudget.status === "soft_exceeded") {
    reasons.push(healthReason(
      "process_group_memory_budget_exceeded",
      memoryBudget.status === "hard_exceeded" ? "critical" : "warning",
      "process_group_memory",
      String(memoryBudget.status)
    ));
  }
  const state = reasons.some((item) => item.severity === "critical") ? "failed" : reasons.length > 0 ? "degraded" : "healthy";
  return { state, reasons };
}

export function unavailableProcessGroupMemory(): Record<string, unknown> {
  return {
    contract: PROCESS_GROUP_MEMORY_CONTRACT,
    sampled_at: "",
    freshness: { age_ms: null, stale_after_ms: 5_000, status: "unavailable" },
    phase: "unknown",
    aggregate: { footprint_bytes: null, process_count: 0, rss_bytes: null, rss_p95_bytes: null },
    roles: [],
    top_by_rss: [],
    recently_exited: [],
    budget: { auto_restart: false, status: "unavailable" }
  };
}

export function healthReason(code: string, severity: "critical" | "warning", sourceRef: string, message: string): Record<string, unknown> {
  return { code, severity, source_ref: sourceRef, message: redactSensitiveText(message) };
}

export function arrayObjects(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(objectValue) : [];
}

export function requiredProviderIDs(database: RunnerDatabase): Set<string> {
  return new Set(database.sqlite.query<{ provider: string }, []>(`
    select provider from projects where trim(provider)<>''
    union
    select provider from issue_runs where ended_at='' and trim(provider)<>''
  `).all().map((row) => String(row.provider)));
}
