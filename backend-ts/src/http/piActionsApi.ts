import type { RunnerDatabase } from "../db/database.ts";
import { listPiActions, type PiActionFilter } from "../db/repositories/pi.ts";
import { json } from "./errors.ts";
import type { Router } from "./router.ts";

type PiActionsContext = { database: RunnerDatabase };

export function registerPiActionRoutes(router: Router, context: PiActionsContext): void {
  router.get("/api/pi/actions", (request) => json(listPiActions(context.database, piActionFilter(request))));
}

function piActionFilter(request: Request): PiActionFilter {
  const params = new URL(request.url).searchParams;
  return {
    conversationId: cleanParam(params.get("conversation_id")),
    issueId: positiveID(params.get("issue_id")),
    projectId: cleanParam(params.get("project_id")),
    status: cleanParam(params.get("status"))
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
