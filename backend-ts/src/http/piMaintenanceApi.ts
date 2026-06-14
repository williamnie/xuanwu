import type { RunnerDatabase } from "../db/database.ts";
import { applyStalePendingActions, dryRunStalePendingActions } from "../pi/stalePendingActions.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

type PiMaintenanceContext = {
  database: RunnerDatabase;
};

export function registerPiMaintenanceRoutes(router: Router, context: PiMaintenanceContext): void {
  router.get("/api/pi/maintenance/stale-pending-actions", () => json(dryRunStalePendingActions(context.database)));
  router.post("/api/pi/maintenance/stale-pending-actions/apply", async (request) => {
    const body = await parseObjectBody(request);
    if (body.confirm !== true) throw new HttpError(400, "confirm=true is required before applying stale cleanup");
    return json(applyStalePendingActions(context.database, { backupDir: cleanString(body.backup_dir) }));
  });
}

async function parseObjectBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await parseJsonBody(request);
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch (error) {
    if (error instanceof HttpError) throw new HttpError(400, "请求体不是合法 JSON");
    throw error;
  }
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
