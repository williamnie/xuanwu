import type { RunnerDatabase } from "../../db/database.ts";
import { listPiActivityTimeline } from "../../db/repositories/pi.ts";
import { HttpError, json } from "../errors.ts";
import type { Router } from "../router.ts";
import { cleanString } from "../../util/values.ts";

type PiActivityContext = { database: RunnerDatabase };

export function registerPiActivityRoutes(router: Router, context: PiActivityContext): void {
  router.get("/api/pi/activity", (request) => json(listPiActivityTimeline(context.database, activityFilter(request))));
}

function activityFilter(request: Request) {
  const params = new URL(request.url).searchParams;
  return {
    conversationId: cleanString(params.get("conversation_id") || params.get("conversationId")),
    inboxItemId: optionalPositiveInt(params.get("inbox_item_id") || params.get("inboxItemId"), "inbox_item_id"),
    issueId: optionalPositiveInt(params.get("issue_id") || params.get("issueId"), "issue_id"),
    limit: optionalPositiveInt(params.get("limit"), "limit"),
    proposalId: cleanString(params.get("proposal_id") || params.get("proposalId")),
    since: cleanString(params.get("since") || params.get("from")),
    source: cleanString(params.get("source")),
    until: cleanString(params.get("until") || params.get("to"))
  };
}

function optionalPositiveInt(value: string | null, label: string): number | undefined {
  const text = cleanString(value);
  if (text === "") return undefined;
  if (!/^\d+$/.test(text)) throw new HttpError(400, `${label} must be a positive integer`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new HttpError(400, `${label} must be a positive integer`);
  return parsed;
}
