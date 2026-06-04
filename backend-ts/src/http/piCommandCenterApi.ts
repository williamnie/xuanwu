import type { RunnerDatabase } from "../db/database.ts";
import {
  listPiActions,
  listPiDelegations,
  listPiHeartbeatRuns,
  listProjectPiSettings,
  type PiHeartbeatRun
} from "../db/repositories/pi.ts";
import type { Router } from "./router.ts";
import { json } from "./errors.ts";

type PiCommandCenterContext = { database: RunnerDatabase };

export function registerPiCommandCenterRoutes(router: Router, context: PiCommandCenterContext): void {
  router.get("/api/pi/command-center", () => json(buildPiCommandCenter(context.database)));
}

function buildPiCommandCenter(db: RunnerDatabase) {
  const settings = listProjectPiSettings(db);
  const activeDelegations = listPiDelegations(db, { status: "active" });
  const pendingApprovals = listPiActions(db, { status: "pending" });
  const latestRun = listPiHeartbeatRuns(db).at(0) ?? null;

  return {
    generated_at: new Date().toISOString(),
    mode: commandMode(settings, activeDelegations.length),
    overview: {
      active_delegations: activeDelegations.length,
      autonomous_projects: settings.filter((item) => item.auto_manage === 1).length,
      pending_approvals: pendingApprovals.length
    },
    heartbeat: heartbeatSummary(latestRun)
  };
}

function commandMode(settings: Array<{ auto_manage: number }>, activeDelegations: number): string {
  if (settings.some((item) => item.auto_manage === 1) || activeDelegations > 0) return "delegated";
  if (settings.length > 0) return "attended";
  return "manual";
}

function heartbeatSummary(latestRun: PiHeartbeatRun | null) {
  return {
    latest_run: latestRun,
    status: latestRun?.status || "idle"
  };
}
