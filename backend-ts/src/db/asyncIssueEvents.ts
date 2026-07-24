import type { RunnerDatabase } from "./database.ts";
import { listIssueEvents, type IssueEvent, type ListIssueEventsOptions } from "./repositories/issueEvents.ts";

const DEFAULT_ASYNC_EVENT_LIMIT = 100;

/**
 * Event reads used to spawn one copy of the full runner binary per request.
 * Concurrent reads could truncate the worker stdout JSON and leave the Bun HTTP
 * accept loop unhealthy. The indexed, bounded query is sub-millisecond when
 * warm (and only a few milliseconds cold), so keep it on the dedicated
 * read-only SQLite connection instead of crossing a process/JSON boundary.
 */
export async function listIssueEventsAsync(
  db: RunnerDatabase,
  issueID: number,
  options: ListIssueEventsOptions = {}
): Promise<IssueEvent[]> {
  const preserveLegacyOrder = options.limit === undefined &&
    options.afterID === undefined &&
    options.beforeID === undefined;
  const events = listIssueEvents(db, issueID, {
    ...options,
    hydrateArtifacts: options.hydrateArtifacts === true,
    limit: options.limit ?? DEFAULT_ASYNC_EVENT_LIMIT
  });
  return preserveLegacyOrder ? events.sort(compareIssueEvents) : events;
}

function compareIssueEvents(left: IssueEvent, right: IssueEvent): number {
  return left.created_at.localeCompare(right.created_at) || left.id - right.id;
}
