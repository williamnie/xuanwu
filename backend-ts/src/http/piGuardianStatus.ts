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
    managed: number;
    project_id: string;
  }, []>(`
    select
      projects.id as project_id,
      case when project_pi_settings.project_id is not null and supervisor.enabled=1 then 1 else 0 end as managed
    from projects
    left join project_pi_settings on project_pi_settings.project_id=projects.id
    left join pi_agents supervisor on supervisor.id='runner-default'
    order by projects.sort_order asc, projects.created_at asc, projects.id asc
  `).all();
  const modes = projects.map((project) => ({
    project_id: project.project_id,
    managed: project.managed === 1
  }));
  const managed = modes.filter((mode) => mode.managed).length;
  return {
    contract: "xuanwu.guardian-runtime-modes.v2",
    managed_projects: managed,
    unmanaged_projects: modes.length - managed,
    projects: modes,
    summary: `${managed} project(s) managed by Supervisor.`
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
