import { buildDeliveryEffectiveness } from "./deliveryEffectiveness.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { basename, join } from "node:path";
import { redactRegisteredSecrets } from "../security/redactionRegistry.ts";
import { runtimeObservabilityCache, RUNTIME_OBSERVABILITY_CACHE_TTL_MS, RUNTIME_OBSERVABILITY_SCHEMA_VERSION, RUNTIME_OBSERVABILITY_WORKER_TIMEOUT_MS } from "./runtimeObservability.model.ts";
import { statusCounts, workflowMetrics, providerMetrics, eventTypeCounts, dimension, scalar, aggregateProviderCost, healthSignals } from "./runtimeObservability.metrics.ts";
import { traceRows, traceView, structuredEventRows, structuredEventView } from "./runtimeObservability.traces.ts";

/**
 * Read-only operational projection. Every query uses durable domain tables or
 * event_summary_projection; it never reads provider session JSONL or runtime log files.
 */
export function buildRuntimeObservability(database: RunnerDatabase, now?: Date): Record<string, unknown> {
  // This is a diagnostic snapshot assembled from several aggregate queries.
  // Page polling does not need sub-second freshness, and rebuilding it for
  // every status request can monopolize the local Core for hundreds of ms.
  // Explicit timestamps (tests/reports) bypass the runtime cache.
  const cacheable = now === undefined;
  const cached = cacheable ? runtimeObservabilityCache.get(database.path) : undefined;
  if (cached) {
    if (cached.expiresAt <= Date.now() && !cached.refreshing) {
      cached.refreshing = refreshRuntimeObservabilityInWorker(database.path)
        .then((value) => {
          runtimeObservabilityCache.set(database.path, {
            expiresAt: Date.now() + RUNTIME_OBSERVABILITY_CACHE_TTL_MS,
            value: redactRegisteredSecrets(value) as Record<string, unknown>
          });
        })
        .catch((error) => {
          cached.expiresAt = Date.now() + RUNTIME_OBSERVABILITY_CACHE_TTL_MS;
          console.warn(JSON.stringify({
            event: "runner.runtime_observability_refresh_failed",
            error: error instanceof Error ? error.message : String(error)
          }));
        })
        .finally(() => {
          cached.refreshing = undefined;
        });
    }
    return cached.value;
  }
  return buildAndCacheRuntimeObservability(database, now, cacheable);
}

/**
 * Populate the live status cache before the HTTP listener is exposed. Later
 * refreshes use the same isolated reader process and return the last complete
 * snapshot immediately, so aggregate diagnostics never block page requests.
 */
export async function primeRuntimeObservability(database: RunnerDatabase): Promise<void> {
  const value = await refreshRuntimeObservabilityInWorker(database.path);
  runtimeObservabilityCache.set(database.path, {
    expiresAt: Date.now() + RUNTIME_OBSERVABILITY_CACHE_TTL_MS,
    value: redactRegisteredSecrets(value) as Record<string, unknown>
  });
}

export function buildAndCacheRuntimeObservability(
  database: RunnerDatabase,
  now: Date | undefined,
  cacheable: boolean
): Record<string, unknown> {
  const generatedAt = (now ?? new Date()).toISOString();
  const workStatuses = statusCounts(database, "issues");
  const runStatuses = statusCounts(database, "issue_runs");
  const automationStatuses = statusCounts(database, "automation_runs");
  const workflows = workflowMetrics(database);
  const providers = providerMetrics(database);
  const traces = traceRows(database).map(traceView);
  const structuredEvents = structuredEventRows(database).map(structuredEventView);
  const eventTypes = eventTypeCounts(database);
  const snapshot = {
    schema_version: RUNTIME_OBSERVABILITY_SCHEMA_VERSION,
    generated_at: generatedAt,
    source_of_truth: {
      work: "issues",
      run: "issue_runs+run_attempts",
      workflow: "works+automation_execution_links+canonical-workflow-fallback",
      provider_cost: "run_attempts.cost_json",
      automation: "automation_definitions+automation_runs+automation_execution_links",
      structured_events: "event_summary_projection"
    },
    query_contract: {
      raw_log_scan: false,
      provider_session_scan: false,
      event_payload_source: "event_summary_projection",
      projection_only: true
    },
    dimensions: {
      work: dimension(workStatuses, "issues"),
      run: {
        ...dimension(runStatuses, "issue_runs"),
        attempts: scalar(database, "select count(*) as count from run_attempts")
      },
      workflow: {
        source: "works+automation_execution_links+canonical-workflow-fallback",
        total: workflows.length,
        items: workflows
      },
      provider: {
        source: "run_attempts.cost_json",
        total: providers.length,
        items: providers
      },
      automation: {
        ...dimension(automationStatuses, "automation_runs"),
        definitions: scalar(database, "select count(*) as count from automation_definitions"),
        linked_runs: scalar(database, "select count(*) as count from automation_execution_links")
      }
    },
    cost: aggregateProviderCost(providers),
    delivery_effectiveness: buildDeliveryEffectiveness(database, new Date(generatedAt)),
    health_signals: healthSignals(database, traces, generatedAt),
    trace_correlation: {
      trace_id_contract: "canonical Work id",
      items: traces
    },
    structured_events: {
      source: "event_summary_projection",
      counts_by_type: Object.fromEntries(eventTypes.map((row) => [row.key, row.count])),
      items: structuredEvents
    }
  };
  const value = redactRegisteredSecrets(snapshot) as Record<string, unknown>;
  if (cacheable) {
    runtimeObservabilityCache.set(database.path, {
      expiresAt: Date.now() + RUNTIME_OBSERVABILITY_CACHE_TTL_MS,
      value
    });
  }
  return value;
}

export async function refreshRuntimeObservabilityInWorker(databasePath: string): Promise<Record<string, unknown>> {
  const workerArgs = ["__runtime-observability-worker", databasePath, String(process.pid)];
  const command = basename(process.execPath).startsWith("bun")
    ? [process.execPath, join(import.meta.dir, "../main.ts"), ...workerArgs]
    : [process.execPath, ...workerArgs];
  const child = Bun.spawn({
    cmd: command,
    env: workerEnvironment(),
    stderr: "pipe",
    stdout: "pipe"
  });
  const timeout = setTimeout(() => child.kill(), RUNTIME_OBSERVABILITY_WORKER_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]).finally(() => clearTimeout(timeout));
  if (exitCode !== 0) {
    throw new Error(`runtime observability worker failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
  }
  const parsed = JSON.parse(stdout) as { ok?: boolean; snapshot?: Record<string, unknown> };
  if (!parsed.ok || !parsed.snapshot) throw new Error("runtime observability worker returned an invalid result");
  return parsed.snapshot;
}

export function workerEnvironment(): Record<string, string> {
  return Object.fromEntries(["HOME", "PATH", "TMPDIR", "TZ"]
    .map((key) => [key, Bun.env[key] ?? ""])
    .filter(([, value]) => value !== ""));
}
