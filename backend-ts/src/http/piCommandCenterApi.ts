import type { RunnerDatabase } from "../db/database.ts";
import { listCronTasks } from "../db/repositories/cronTasks.ts";
import { listIssues } from "../db/repositories/issues.ts";
import {
  listPiActionEvents,
  listPiActions,
  listPiDelegations,
  listPiHeartbeatEvents,
  listPiHeartbeatRuns,
  listProjectPiSettings
} from "../db/repositories/pi.ts";
import { listProjects } from "../db/repositories/projects.ts";
import type { Router } from "./router.ts";
import { json } from "./errors.ts";

type PiCommandCenterContext = { database: RunnerDatabase };

export function registerPiCommandCenterRoutes(router: Router, context: PiCommandCenterContext): void {
  router.get("/api/pi/command-center", () => json(buildPiCommandCenter(context.database)));
}

function buildPiCommandCenter(db: RunnerDatabase) {
  const projects = listProjects(db);
  const settings = listProjectPiSettings(db);
  const delegations = listPiDelegations(db);
  const activeDelegations = delegations.filter((item) => item.status === "active");
  const pending = listPiActions(db, { status: "pending" });
  const issues = listIssues(db);
  const running = issues.filter((issue) => issue.status === "in_progress");
  const failed = issues.filter((issue) => issue.status === "failed");
  const cronTasks = listCronTasks(db);
  return {
    generated_at: new Date().toISOString(),
    mode: commandMode(settings, activeDelegations.length),
    overview: {
      active_delegations: activeDelegations.length,
      autonomous_projects: settings.filter((item) => item.auto_manage === 1).length,
      pending_approvals: pending.length,
      running_issues: running.length
    },
    projects,
    pi_settings: settings,
    delegations,
    pending_approvals: pending,
    running_issues: running,
    heartbeat: {
      recent_events: listPiHeartbeatEvents(db).slice(-40).reverse(),
      recent_runs: listPiHeartbeatRuns(db).slice(0, 16)
    },
    audit_events: listPiActionEvents(db).slice(-40).reverse(),
    cron_tasks: cronTasks,
    reports: buildReports(issues, failed, cronTasks)
  };
}

function commandMode(settings: Array<{ auto_manage: number }>, activeDelegations: number): string {
  if (settings.some((item) => item.auto_manage === 1) || activeDelegations > 0) return "delegated";
  if (settings.length > 0) return "attended";
  return "manual";
}

function buildReports(
  issues: Array<{ error: string; status: string }>,
  failed: Array<{ error: string; id: number; title: string; updated_at: string }>,
  cronTasks: Array<{ action: string; last_result: string; last_run_at: string; last_status: string; name: string }>
) {
  return {
    daily_summary: countByStatus(issues),
    failure_summary: {
      count: failed.length,
      latest: failed.slice(0, 8).map((issue) => ({
        error: issue.error,
        id: issue.id,
        title: issue.title,
        updated_at: issue.updated_at
      }))
    },
    nightly: cronTasks.filter((task) => task.action === "generate_report").slice(0, 6),
    usage: { source: "/api/usage/codex", status: "available" }
  };
}

function countByStatus(issues: Array<{ status: string }>): Record<string, number> {
  return issues.reduce<Record<string, number>>((acc, issue) => {
    acc[issue.status] = (acc[issue.status] ?? 0) + 1;
    return acc;
  }, {});
}
