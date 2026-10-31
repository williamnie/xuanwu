import type { RunnerDatabase } from "../database.ts";
import { EVENT_SUMMARY_SOURCE, type EventSummaryProjection } from "./eventSummaryProjection.ts";
import { type EventSummaryProjectionSwitch, SWITCH_ID } from "./compactEventSummaryProjectionModel.ts";

export function getEventSummaryProjectionSwitch(db: RunnerDatabase): EventSummaryProjectionSwitch {
  const row = db.sqlite.query<Record<string, unknown>, [string]>(`
    select read_version, observation_started_at, observation_expires_at,
      cutover_at, updated_at, revision
    from event_summary_projection_switch where projection_id=?
  `).get(SWITCH_ID);
  if (!row || (row.read_version !== "v1" && row.read_version !== "v2")) {
    throw new Error("event summary projection switch is missing or invalid");
  }
  return {
    cutover_at: String(row.cutover_at ?? ""),
    observation_expires_at: String(row.observation_expires_at ?? ""),
    observation_started_at: String(row.observation_started_at ?? ""),
    read_version: row.read_version,
    revision: Number(row.revision),
    updated_at: String(row.updated_at ?? "")
  };
}

export function updateEventSummaryProjectionSwitch(
  db: RunnerDatabase,
  input: Pick<EventSummaryProjectionSwitch, "cutover_at" | "observation_expires_at" | "observation_started_at" | "read_version"> & {
    expectedRevision: number;
    updatedAt: string;
  }
): EventSummaryProjectionSwitch {
  const result = db.sqlite.run(`
    update event_summary_projection_switch set
      read_version=?, observation_started_at=?, observation_expires_at=?,
      cutover_at=?, updated_at=?, revision=revision+1
    where projection_id=? and revision=?
  `, [
    input.read_version,
    input.observation_started_at,
    input.observation_expires_at,
    input.cutover_at,
    input.updatedAt,
    SWITCH_ID,
    input.expectedRevision
  ]);
  if (Number(result.changes) !== 1) throw new Error("event summary projection switch revision conflict");
  return getEventSummaryProjectionSwitch(db);
}

export function assertProjectionParity(
  legacy: EventSummaryProjection[],
  compact: EventSummaryProjection[]
): void {
  const comparable = (row: EventSummaryProjection) => ({
    ...row,
    projected_at: "",
    source: EVENT_SUMMARY_SOURCE
  });
  if (legacy.length !== compact.length) {
    throw new Error(`event summary projection parity conflict: row count ${legacy.length} != ${compact.length}`);
  }
  for (let index = 0; index < legacy.length; index += 1) {
    if (JSON.stringify(comparable(legacy[index]!)) !== JSON.stringify(comparable(compact[index]!))) {
      throw new Error(`event summary projection parity conflict at source event ${legacy[index]!.source_event_id}`);
    }
  }
}
