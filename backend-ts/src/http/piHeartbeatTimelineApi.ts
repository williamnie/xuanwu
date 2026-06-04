import { listPiHeartbeatTimeline } from "../db/repositories/pi.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { json } from "./errors.ts";
import type { Router } from "./router.ts";

type PiHeartbeatTimelineContext = { database: RunnerDatabase };

export function registerPiHeartbeatTimelineRoutes(
  router: Router,
  context: PiHeartbeatTimelineContext
): void {
  router.get("/api/pi/heartbeat-timeline", (request) => json(
    listPiHeartbeatTimeline(context.database, timelineFilter(request))
  ));
}

function timelineFilter(request: Request) {
  const params = new URL(request.url).searchParams;
  return {
    issueId: positiveID(params.get("issue_id") || params.get("issueId")),
    limit: positiveID(params.get("limit")),
    projectId: cleanParam(params.get("project_id") || params.get("projectId"))
  };
}

function positiveID(value: string | null): number | undefined {
  const text = cleanParam(value);
  if (text === "") return undefined;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function cleanParam(value: string | null): string {
  return value?.trim() ?? "";
}
