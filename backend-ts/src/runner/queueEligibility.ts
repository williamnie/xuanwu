import type { IssueDependencyDiagnostic } from "../domain/work/issueDependency.ts";
import type { ExecutorProvider } from "../providers/types.ts";
import { redactSensitiveText } from "../util/redact.ts";

type ScheduleCode = "project_hold" | "auto_run_off" | "dependency_waiting" | "dependency_failed"
  | "dependency_missing" | "dependency_cycle" | "readiness_waiting" | "workspace_waiting"
  | "provider_unavailable" | "project_busy" | "capacity_full";
type ScheduleReason = { code: ScheduleCode; detail?: Record<string, unknown> };
export type WorkSchedule = { state: "runnable" | "waiting"; reasons: ScheduleReason[] };
type ProviderAvailability = { ready: boolean; provider_id: string; category?: string; reason?: string };

export function providerAvailability(id: string, provider?: ExecutorProvider): ProviderAvailability {
  if (!provider) return { ready: false, provider_id: id, category: "not_registered" };
  if (!provider.capabilities.includes("issue_execution")) return { ready: false, provider_id: id, category: "unsupported_capability" };
  const status = provider.runtimeStatus?.();
  return status?.ready === false
    ? { ready: false, provider_id: id, category: "runtime_not_ready", ...(status.reason ? { reason: redactSensitiveText(status.reason) } : {}) }
    : { ready: true, provider_id: id };
}

/** Shared pure candidate gates. Callers may evaluate a subset at the scheduler's existing stages.
 * Order is diagnostic priority, not a promise about manager entry-point evaluation order. */
export function evaluateQueueCandidate(input: {
  project?: { hold?: unknown; auto_run: number };
  forceOnce?: boolean;
  dependency?: IssueDependencyDiagnostic;
  workspaceWaiting?: boolean;
  provider?: ProviderAvailability;
}): ScheduleReason[] {
  const reasons: ScheduleReason[] = [];
  if (input.project?.hold) reasons.push({ code: "project_hold" });
  if (input.project && input.project.auto_run !== 1 && !input.forceOnce) reasons.push({ code: "auto_run_off" });
  const dependency = input.dependency;
  if (dependency && !dependency.ready) {
    const codes = { waiting_dependency: "dependency_waiting", failed_dependency: "dependency_failed",
      missing_dependency: "dependency_missing", dependency_cycle: "dependency_cycle", waiting_readiness: "readiness_waiting" } as const;
    if (dependency.reason !== "ready") reasons.push({ code: codes[dependency.reason], detail: {
      root_blockers: dependency.root_blockers, cycle_work_ids: dependency.cycle_work_ids
    } });
  }
  if (input.workspaceWaiting) reasons.push({ code: "workspace_waiting" });
  if (input.provider && !input.provider.ready) {
    const { ready: _, ...detail } = input.provider;
    reasons.push({ code: "provider_unavailable", detail });
  }
  return reasons;
}

export function projectCapacityAvailable(openRuns: number, workers: number, maximum: number): boolean {
  return openRuns < maximum && workers < maximum;
}
