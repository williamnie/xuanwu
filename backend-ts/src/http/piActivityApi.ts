import type { RunnerDatabase } from "../db/database.ts";
import { listPiActivityTimeline } from "../db/repositories/pi.ts";
import { HttpError, json } from "./errors.ts";
import type { Router } from "./router.ts";

type PiActivityContext = { database: RunnerDatabase };

export function registerPiActivityRoutes(router: Router, context: PiActivityContext): void {
  router.get("/api/pi/activity", (request) => json(listPiActivityTimeline(context.database, activityFilter(request))));
}

function activityFilter(request: Request) {
  const params = new URL(request.url).searchParams;
  return {
    inboxItemId: optionalPositiveInt(params.get("inbox_item_id") || params.get("inboxItemId"), "inbox_item_id"),
    issueId: optionalPositiveInt(params.get("issue_id") || params.get("issueId"), "issue_id"),
    limit: optionalPositiveInt(params.get("limit"), "limit"),
    proposalId: clean(params.get("proposal_id") || params.get("proposalId")),
    since: clean(params.get("since") || params.get("from")),
    source: clean(params.get("source")),
    until: clean(params.get("until") || params.get("to"))
  };
}

function optionalPositiveInt(value: string | null, label: string): number | undefined {
  const text = clean(value);
  if (text === "") return undefined;
  if (!/^\d+$/.test(text)) throw new HttpError(400, `${label} must be a positive integer`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new HttpError(400, `${label} must be a positive integer`);
  return parsed;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
