import type { RunnerDatabase } from "../../database.ts";
import { buildPiActivityNodes } from "./activityTimelineNodes.ts";
import { buildPiActivityScope, loadPiActivityRows } from "./activityTimelineScope.ts";
import type { PiActivityFilter, PiActivityTimeline } from "./activityTimelineTypes.ts";
import { compareNodes, inWindow, publicFilters, resultLimit } from "./activityTimelineSupport.ts";

export type { PiActivityFilter, PiActivityNode, PiActivityTimeline } from "./activityTimelineTypes.ts";

export function listPiActivityTimeline(db: RunnerDatabase, filter: PiActivityFilter = {}): PiActivityTimeline {
  const rows = loadPiActivityRows(db, filter);
  const scope = buildPiActivityScope(db, rows, filter);
  const items = buildPiActivityNodes(db, rows, scope)
    .filter((node) => inWindow(node.at, filter.since, filter.until))
    .sort(compareNodes)
    .slice(-resultLimit(filter.limit));
  return { filters: publicFilters(filter), generated_at: new Date().toISOString(), items };
}
