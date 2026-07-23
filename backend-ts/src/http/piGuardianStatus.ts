import type { RunnerDatabase } from "../db/database.ts";
import { getPiGuardianWatchdogStatus } from "../db/repositories/pi.ts";
import { issueCompletionAutomationCounts } from "../pi/issueCompletionAutomation.ts";

export const PI_GUARDIAN_WATCHDOG_STALE_AFTER_MS = 120_000;

export function buildPiGuardianSystemStatus(
  database: RunnerDatabase,
  now: Date = new Date()
): Record<string, unknown> {
  const status = getPiGuardianWatchdogStatus(database);
  const lastSeen = status?.last_seen_at ?? "";
  return {
    completion_watch: issueCompletionAutomationCounts(database),
    runtime_modes: guardianRuntimeModes(database),
    watchdog: {
      is_stale: isWatchdogStale(lastSeen, now),
      last_seen: lastSeen,
      stale_after: staleAfter(lastSeen)
    }
  };
}

function guardianRuntimeModes(database: RunnerDatabase): Record<string, unknown> {
  const projects = database.sqlite.query<{
    auto_manage: number;
    project_id: string;
    supervisor_mode: string;
  }, []>(`
    select
      projects.id as project_id,
      coalesce(project_pi_settings.auto_manage, 0) as auto_manage,
      coalesce(project_pi_policies.supervisor_mode, 'autonomous') as supervisor_mode
    from projects
    left join project_pi_settings on project_pi_settings.project_id=projects.id
    left join project_pi_policies on project_pi_policies.project_id=projects.id
    order by projects.sort_order asc, projects.created_at asc, projects.id asc
  `).all();
  const modes = projects.map((project) => ({
    project_id: project.project_id,
    manager_active: project.auto_manage === 1,
    supervisor_active: project.supervisor_mode !== "off",
    supervisor_mode: project.supervisor_mode
  }));
  const managerActive = modes.filter((mode) => mode.manager_active).length;
  const supervisorActive = modes.filter((mode) => mode.supervisor_active).length;
  return {
    contract: "xuanwu.guardian-runtime-modes.v1",
    manager_active_projects: managerActive,
    manager_disabled_projects: modes.length - managerActive,
    projects: modes,
    supervisor_active_projects: supervisorActive,
    supervisor_independent_of_manager: true,
    summary: managerActive === 0 && supervisorActive > 0
      ? "Project manager is disabled; only the independent Guardian supervisor is active."
      : `${managerActive} project manager(s), ${supervisorActive} Guardian supervisor(s) active.`
  };
}

function isWatchdogStale(lastSeen: string, now: Date): boolean {
  const seenAt = Date.parse(lastSeen);
  if (!Number.isFinite(seenAt)) return true;
  return now.getTime() - seenAt > PI_GUARDIAN_WATCHDOG_STALE_AFTER_MS;
}

function staleAfter(lastSeen: string): string {
  const seenAt = Date.parse(lastSeen);
  if (!Number.isFinite(seenAt)) return "";
  return iso(new Date(seenAt + PI_GUARDIAN_WATCHDOG_STALE_AFTER_MS));
}

function iso(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}
