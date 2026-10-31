import type { RunnerDatabase } from "../db/database.ts";
import { cleanString } from "../util/values.ts";
import type { WatchdogState, StoredWatchdogState } from "./issueWatchdog.model.ts";
import { parsePayload } from "./issueWatchdog.queries.ts";

export function statePayload(state: WatchdogState, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    authority: state.authority,
    next_check_at: state.nextCheckAt,
    not_runnable_reason: state.reason === "ready" ? "" : state.reason,
    root_blocker: state.rootBlocker,
    state_key: state.stateKey,
    ...extra
  };
}

export function latestWatchdogState(db: RunnerDatabase, issueID: number): StoredWatchdogState {
  const row = db.sqlite.query<{ payload: string }, [number]>(`
    select payload from issue_events
    where issue_id=? and type in ('issue.watchdog_kicked', 'issue.watchdog_needs_user', 'issue.watchdog_waiting')
    order by id desc limit 1
  `).get(issueID);
  return { stateKey: cleanString(parsePayload(row?.payload).state_key) };
}
